# EKS/K8s + Lambda 병행 지원 전환 계획서 v1

## 1. 목표

이 시스템은 기존 Kubernetes 운영 경로를 유지하면서, 동일한 모니터링/알림 로직을 AWS Lambda에서도 실행 가능하도록 구조를 개편한다.

이번 작업의 1차 목표는 다음이다.

1. 공통 비즈니스 로직을 K8s 프로세스 모델과 분리한다.
2. 상태 저장소를 백엔드별로 교체 가능하게 만든다.
3. Lambda 런타임을 신규 추가한다.
4. 중복 알림 방지는 DynamoDB를 기준 구현으로 추가한다.
5. 기존 K8s 운영 경로가 깨지지 않도록 호환성을 유지한다.

---

## 2. 최종 아키텍처 합의안

### 2-1. 런타임 구조

**K8s 런타임**
- long-running process
- while loop 유지
- readiness marker 유지
- signal handling 유지
- leader election 유지 가능
- Redis/file/memory state 사용 가능

**Lambda 런타임**
- 1 invocation = 1 poll cycle
- while loop 없음
- readiness marker 없음
- signal handling 없음
- leader election 없음
- DynamoDB state 사용
- EventBridge Scheduler가 주기 실행 담당

---

### 2-2. 상태 저장 전략

상태 저장은 아래 백엔드를 지원한다.

- memory
- file
- redis
- dynamodb

권장 사용 방식:
- 로컬 개발: memory 또는 file
- 기존 K8s: redis
- Lambda: dynamodb

---

### 2-3. Lambda 중복 실행/중복 알림 전략

Lambda에서는 두 문제를 분리해서 다룬다.

**A. 실행 중복**
- Lambda Reserved Concurrency = 1
- 목적: 동시에 두 poll cycle이 겹치지 않게 함

**B. 알림 중복**
- DynamoDB conditional write 사용
- 목적: 같은 post ID를 7일 동안 재알림하지 않음

**DynamoDB 규칙**
- PK: `postId`
- TTL attribute: `expiresAt`
- `claim(id)`는 conditional put
- `unclaim(id)`는 delete
- TTL은 cleanup 용도이며, 실제 만료 판정은 앱 로직도 고려해야 함

---

## 3. 단계별 실행 계획

### Phase 1. 공통 코어 분리

**목적**: 현재 `src/index.ts`에 섞여 있는 공통 로직과 프로세스 로직을 분리한다.

**수정할 것**
- `src/index.ts`에서 `pollOnce()`를 공통 모듈로 분리
- notifier config validation 로직도 별도 함수로 분리
- K8s 전용 요소 분리: readiness marker, signal handling, infinite loop, leader election 대기, startup firstRun 정책

**구현할 것**
- `src/app/poll.ts`
- `src/app/validateNotifierConfig.ts`
- `src/entrypoints/k8s.ts`
- `src/entrypoints/lambda.ts`

**완료 조건**
- poll 1회 로직이 엔트리포인트와 독립적으로 호출 가능해야 함
- 기존 K8s start 경로가 동일 동작해야 함

---

### Phase 2. StateStore 추상화

**목적**: Redis 고정 구조를 백엔드 선택 구조로 변경한다.

**수정할 것**
- 현재 StateStore를 팩토리/인터페이스 구조로 정리
- `config.ts`에 백엔드 선택값 추가

**구현할 것**
- `src/state/types.ts` — StateStore 인터페이스
- `src/state/factory.ts` — 백엔드 팩토리
- `src/state/memory.ts`
- `src/state/file.ts`
- `src/state/redis.ts`
- `src/state/dynamodb.ts`

**새 환경변수**
- `STATE_BACKEND=memory|file|redis|dynamodb`
- `DYNAMODB_TABLE_NAME`
- `DYNAMODB_TTL_SECONDS`

**완료 조건**
- K8s에서는 기존 Redis 동작 유지
- Lambda에서는 DynamoDB 백엔드 선택 가능
- 기존 `claim/has/unclaim/save/load/close` 의미 유지

---

### Phase 3. DynamoDB 구현

**목적**: Redis 대체용 DynamoDB dedupe backend 추가

**DynamoDB 테이블**
- Table: `hotdeal-seen-posts`
- PK: `postId` (string)
- TTL: `expiresAt` (number, epoch seconds)

**메서드 규칙**
- `claim(id)`: 조건부 PutItem. 이미 있고 만료 안 됐으면 false
- `has(id)`: 조회 후 `expiresAt > now`일 때만 true
- `unclaim(id)`: DeleteItem
- `save/load/close`: no-op

**주의사항**
- DynamoDB TTL 삭제가 늦을 수 있으므로 만료된 기존 아이템을 앱 로직에서 재허용해야 함

**완료 조건**
- Redis와 동일한 사용자 관점 dedupe 의미 보장
- "7일 경과 후 재알림 가능" 의미가 TTL sweeper 지연과 무관하게 성립해야 함
- **claim(id)는 "아이템이 없거나, 존재하더라도 logical expiration(expiresAt <= now) 상태면 fresh로 취급 가능해야 한다."** (ConditionExpression: `attribute_not_exists(postId) OR expiresAt < :now`)

---

### Phase 4. Lambda 엔트리포인트 추가

**목적**: 1회 실행형 Lambda handler 추가

**구현할 것**
- `src/entrypoints/lambda.ts`
- EventBridge event를 받아 1 cycle 실행
- 실행 결과를 로그로 남기고 정상 종료

**Lambda 엔트리포인트에서 하지 않을 것**
- while loop, sleep, signal handling, readiness 파일, leader election

**유지할 것**
- fetch, keyword match, dedupe, notify, browser cleanup

**완료 조건**
- Lambda handler 단독 호출로 1 cycle 실행 가능
- 예외 시 Lambda 실패로 반환

---

### Phase 5. K8s 엔트리포인트 재정리

**목적**: 기존 운영 경로를 새 구조 위에서 그대로 유지

**구현할 것**
- `src/entrypoints/k8s.ts`
- 기존 `index.ts` 역할 이전

**유지할 것**
- leader election, readiness marker, graceful shutdown, startup firstRun fetch 확장 정책

**완료 조건**
- 기존 K8s 배포가 동작해야 함
- Redis leader election 방식이 회귀 없이 유지돼야 함

---

### Phase 6. 설정 체계 정리

**목적**: K8s/Lambda가 같은 코어를 쓰되 설정만 다르게 주입되도록 정리

**새 환경변수**
- `STATE_BACKEND=redis|dynamodb|file|memory`

**K8s 전용**: `LEADER_ELECTION_*`, `POD_NAME`, `POD_NAMESPACE`
**Lambda 전용**: `DYNAMODB_TABLE_NAME`, `AWS_REGION`

**완료 조건**
- config 하나로 두 런타임 모두 파싱 가능
- 런타임별 무의미한 값이 있어도 깨지지 않음

---

### Phase 7. 테스트 보강

**반드시 추가할 테스트**
- pollOnce 단위 테스트
- state backend 공통 계약 테스트
- DynamoDB backend 테스트
- Lambda handler smoke test

**검증 시나리오**
- claim 성공 시 1회만 전송
- claim 실패 시 skip
- 전송 실패 시 unclaim
- TTL 지난 아이템이 논리상 fresh로 간주되는지
- notifier config validation: 필수 credential 누락 시 에러, dry-run 시 bypass
- K8s entrypoint smoke test: import 및 기본 초기화 회귀 확인
- Redis backend regression: claim/has/unclaim 기존 동작 유지 확인

---

### Phase 8. 배포판 추가

**구현할 것**
- Lambda 배포용 Dockerfile
- EventBridge Scheduler 설정
- DynamoDB table 생성 정의
- IAM Role 정의

**권장**: 초기에는 `CRAWL_MODE=http` 우선, Playwright는 2차

> **1차 범위 기준**: Phase 1~8의 1차 완료 기준은 HTTP crawl mode 기준이며, Playwright on Lambda는 후속 phase로 분리한다.

---

## 4. 컨센서스 요구사항

1. 시스템은 K8s와 Lambda 두 런타임을 모두 지원해야 한다.
2. 공통 비즈니스 로직은 단일 구현으로 유지해야 한다.
3. 엔트리포인트는 K8s 전용과 Lambda 전용으로 분리해야 한다.
4. 상태 저장소는 backend 선택형 구조여야 한다.
5. DynamoDB backend는 Lambda의 기본 dedupe 저장소여야 한다.
6. 기존 Redis backend는 K8s 호환을 위해 유지해야 한다.
7. Lambda는 EventBridge Scheduler 기반 1회 실행형이어야 한다.
8. Lambda의 실행 중복 제어는 reserved concurrency로 보조해야 한다.
9. 중복 알림 방지는 scheduler가 아니라 state backend가 책임져야 한다.
10. DynamoDB TTL은 cleanup 용도로만 간주해야 한다.
11. K8s leader election은 K8s runtime에서만 동작해야 한다.
12. Lambda runtime은 leader election, readiness marker, signal handling에 의존하면 안 된다.
13. 기존 전송 실패 시 unclaim/retry semantics는 유지해야 한다.
14. 기존 K8s 배포는 회귀 없이 계속 동작해야 한다.
15. 리팩토링 완료 후 공통 poll 로직과 state backend에 대한 테스트를 반드시 추가해야 한다.

---

## 5. 배포 최소기준 요구사항

> 이번 구현은 "Redis 제거"가 아니라 "Redis 비필수화"가 목표다.
> 기존 K8s + Redis 경로는 유지하고, Lambda + DynamoDB 경로를 추가하여 두 런타임이 공존 가능해야 한다.

### 5-1. 1차 배포 범위

**반드시 포함**: Lambda 런타임, DynamoDB dedupe, EventBridge Scheduler, CloudWatch Logs, 기존 K8s 유지, Redis 없이 Lambda 정상 동작
**제외 가능**: Playwright on Lambda, Lambda 전용 알람, Step Functions, DLQ/SNS, 완전한 IaC

### 5-2. Lambda 배포 최소기준

- 1 invocation = 1 poll cycle, while loop 금지
- EventBridge Scheduler가 주기 담당
- Reserved Concurrency = 1 설정 가능
- DynamoDB 기본 state backend, Redis 없이 동작
- 전송 실패 시 unclaim semantics 유지, fail-open 정책 유지
- Node 22.x, dist/ 빌드 기준 실행

### 5-3. DynamoDB 최소기준

- 테이블 1개, PK=postId(S), TTL=expiresAt(N), 7일 기본
- claim: `attribute_not_exists(postId) OR expiresAt < :now`
- has: logical unexpired 기준
- PAY_PER_REQUEST, TTL 활성화

### 5-4. 설정 주입

- 비밀값(webhook URL, bot token 등)은 Lambda env 또는 Secrets Manager
- 같은 config.ts가 양쪽 파싱 가능, 무의미한 설정이 있어도 죽지 않아야 함

### 5-5. 관측성

- 실행 시작/종료, cycle 결과, dedupe skip/failure, notifier 실패 로그
- CloudWatch Logs 확인 가능, 기존 로그 이벤트명 유지

### 5-6. 배포 성공 판정 기준

1. K8s 기존 경로 정상 동작
2. Lambda 3분 주기 1회 실행
3. Redis 없이 Lambda 정상 동작
4. DynamoDB dedupe 정상
5. dedupe window 내 중복 알림 없음
6. 전송 실패 시 재시도 가능
7. CloudWatch Logs 확인 가능
8. 운영자 수동 개입 불필요

### 5-7. 1차 제외사항

Playwright on Lambda, warm reuse, container image 최적화, DLQ/SNS, 멀티환경 분리, 자동 롤백, 대시보드/메트릭

---

## 6. 실제 구현 순서

1. pollOnce 분리
2. K8s entrypoint 분리
3. state backend 선택 구조 도입
4. DynamoDB backend 구현
5. Lambda handler 추가
6. 설정 체계 정리
7. 테스트 보강
8. Lambda 배포판 추가 (Dockerfile, EventBridge, DynamoDB table, IAM)
9. 운영 검증 후 점진 전환

> **1차 완료 기준은 HTTP crawl mode 기준이며, Playwright on Lambda는 후속 phase로 분리한다.**
