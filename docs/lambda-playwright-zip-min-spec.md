# Lambda Playwright Zip+Min 구현 요구사항 명세서

## 0. 문서 목적

이 문서는 기존 K8s 운영 경로를 유지하면서, **AWS Lambda zip 배포 + `playwright-core` + `@sparticuz/chromium-min`** 전략으로 Playwright 실행 경로를 추가하기 위한 워커용 구현 명세서다.

이번 명세의 목표는 다음과 같다.

1. 기존 HTTP-only Lambda 경로를 유지한다.
2. Playwright가 필요한 경우를 위해 **zip 기반 브라우저 실행 경로**를 추가한다.
3. Chromium 본체는 함수 zip 안에 직접 넣지 않고, **Layer 또는 S3 browser pack**으로 외부화한다.
4. 배포는 **CloudFormation 기반**으로 유지한다.
5. 기존 K8s + Redis 경로는 그대로 유지하고, Lambda는 DynamoDB 기반 dedupe를 사용한다.

---

## 1. 아키텍처 결정사항

### 1-1. 런타임 구조

시스템은 아래 두 런타임을 모두 지원해야 한다.

#### K8s 런타임
- long-running process 유지
- while loop 유지
- readiness marker 유지
- signal handling 유지
- leader election 유지 가능
- Redis/file/memory state 사용 가능

#### Lambda 런타임
- 1 invocation = 1 poll cycle
- EventBridge가 주기적으로 Lambda 호출
- 기본 state backend는 DynamoDB
- 비VPC 환경에서 동작
- warm reuse에 의존하지 않는 fresh execution 모델
- Playwright 사용 가능

중요:
- Lambda는 브라우저 재사용을 전제로 설계하지 않는다.
- 매 invocation마다 브라우저를 새로 띄워도 정상 동작해야 한다.

---

### 1-2. 상태 저장 전략

지원 backend:
- `memory`
- `file`
- `redis`
- `dynamodb`

권장 사용:
- 로컬 개발: `memory` 또는 `file`
- 기존 K8s: `redis`
- Lambda: `dynamodb`

중요:
- 이번 목표는 **Redis 제거가 아니라 Redis 비필수화**다.
- 기존 K8s + Redis 경로는 계속 동작해야 한다.

---

### 1-3. Lambda 네트워크 전제

Lambda는 **비VPC**로 구성한다.

의미:
- VpcConfig 없음
- public outbound 사용 가능
- FMKorea 접근 가능
- Slack / Telegram / Discord 호출 가능
- DynamoDB public endpoint 접근 가능
- API Gateway / Function URL 같은 public inbound endpoint는 만들지 않음

---

## 2. Playwright Zip+Min 전략

### 2-1. 핵심 전략

Lambda 브라우저 실행 경로는 다음 조합을 기준으로 구현한다.

- `playwright-core`
- `@sparticuz/chromium-min`
- browser pack은 **Lambda Layer 또는 S3 외부 pack** 방식 사용

이 전략의 의미:
- 함수 zip 자체는 작게 유지
- 브라우저 본체는 함수 패키지 밖에서 공급
- 현재 zip 기반 Lambda/CloudFormation 흐름을 유지

---

### 2-2. 왜 이 전략을 쓰는가

이 전략을 선택하는 이유는 다음과 같다.

1. 전체 ECR container image 전략보다 현재 배포 체계를 덜 흔든다.
2. Chromium 본체를 함수 zip에 직접 넣는 방식보다 artifact 크기 부담이 작다.
3. Playwright가 메인 경로가 아니라 **보조/fallback 경로**일 때 적절한 타협안이다.

단점도 인정한다.

1. Layer 또는 S3 pack 관리가 필요하다.
2. 런타임/브라우저 버전 호환성을 계속 신경 써야 한다.
3. cold start 시 browser pack 준비 비용이 생길 수 있다.
4. 구조는 가볍지만 운영은 은근히 귀찮다.

이 문서는 이 tradeoff를 감수하고도 **현재 레포에는 가장 보수적이고 현실적인 Playwright 추가 방식**이라고 판단하는 전제 위에 작성한다.

---

## 3. 코드 구조 요구사항

### 3-1. 공통 로직

공통 비즈니스 로직은 runtime-independent 해야 한다.

필수 유지 구조:
- `src/app/poll.ts`
- `src/app/validateNotifierConfig.ts`
- `src/state/*`
- `src/entrypoints/k8s.ts`
- `src/entrypoints/lambda.ts`

### 3-2. backward compatibility

- `src/index.ts`는 기존처럼 K8s entrypoint를 유지해야 한다.
- 기존 K8s start 경로는 회귀 없이 동작해야 한다.
- 기존 Redis 기반 중복 방지 semantics는 유지해야 한다.

---

## 4. Lambda handler 요구사항

### 4-1. 기본 동작

`src/entrypoints/lambda.ts`는 아래를 만족해야 한다.

- handler export
- 1회 poll cycle 수행
- 실행 시작/종료 로그 기록
- 결과 로그 기록
- 성공 시 정상 종료
- 실패 시 Lambda error 반환

### 4-2. 금지사항

Lambda handler에서 아래는 금지한다.

- while loop
- sleep loop
- signal handling
- readiness marker
- leader election

### 4-3. 리소스 정리

매 invocation 종료 전에 반드시 수행해야 한다.

- browser cleanup
- state store close
- remaining resource cleanup

중요:
- Lambda는 browser reuse 최적화에 의존하지 않는다.
- 브라우저는 매 invocation마다 새로 생성되어도 정상 동작해야 한다.

---

## 5. Playwright 구현 요구사항

### 5-1. 사용 라이브러리

필수 전환 방향:
- `playwright` 직접 의존 대신 검토 후 **`playwright-core` 중심**으로 정리
- Lambda 경로에서는 `@sparticuz/chromium-min`을 사용

워크플로우:
1. Lambda 실행 시 Chromium executable path 확보
2. browser/context/page 생성
3. 대상 페이지 fetch/render
4. anti-bot 또는 fallback 조건 처리
5. 사용 종료 후 cleanup

### 5-2. browser pack 공급 방식

아래 둘 중 하나를 택해 구현한다.

#### 옵션 A. Layer 기반
- browser pack을 Lambda Layer로 제공
- 함수는 `/opt` 경로 또는 적절한 layer 경로에서 pack 사용

#### 옵션 B. S3 기반
- browser pack을 S3에 보관
- 함수가 cold start 시 `/tmp`에 준비해서 사용

기본 권장:
- **1차는 Layer 우선**
- 단, 배포/운영 단순성이 S3 쪽이 더 낫다면 S3 방식도 허용

워커는 둘 중 하나를 선택하되, 선택 이유를 문서에 남겨야 한다.

### 5-3. 환경변수/설정

Playwright Lambda에 필요한 설정은 아래처럼 externalized 해야 한다.

예시:
- `CRAWL_MODE=playwright`
- `PLAYWRIGHT_HEADLESS=true`
- `PLAYWRIGHT_NAV_TIMEOUT_MS`
- `PLAYWRIGHT_WAIT_AFTER_LOAD_MS`
- `PLAYWRIGHT_EXECUTABLE_PATH` 또는 chromium helper가 제공하는 path
- browser pack 위치 관련 설정 (Layer/S3 선택에 따라)

---

## 6. DynamoDB backend 요구사항

### 6-1. 테이블 구조

- PK: `postId` (string)
- TTL attribute: `expiresAt` (number, epoch seconds)
- table name은 parameterized

### 6-2. 동작 규칙

- `claim(id)`는 fresh item일 때만 성공
- 기존 item이 존재하더라도 `expiresAt <= now`이면 논리적으로 fresh 취급 가능해야 함
- `has(id)`는 logical unexpired 기준이어야 함
- `unclaim(id)`는 DeleteItem
- TTL은 cleanup 용도다
- TTL sweeper 지연과 무관하게 앱 로직이 동작해야 한다

### 6-3. 의미 보존

- 기존 dedupe semantics 유지
- 전송 실패 시 unclaim/retry semantics 유지

---

## 7. CloudFormation 요구사항

### 7-1. 배포 방식

배포는 **CloudFormation 기반**이어야 한다.

필수 산출물:
- `infra/cloudformation.yaml`
- Playwright zip 배포를 위한 build/package/deploy 스크립트

CloudFormation은 최소 아래를 관리해야 한다.

1. Lambda Function
2. IAM Role
3. CloudWatch Log Group
4. EventBridge Rule 또는 Scheduler
5. Lambda invoke permission
6. DynamoDB Table
7. 필요 시 Lambda Layer

---

### 7-2. Lambda 설정

기본 Lambda 설정:
- Runtime: `nodejs24.x`
- Memory: `2048`
- Timeout: `60`
- ReservedConcurrentExecutions: `1`
- VpcConfig 없음

환경변수:
- `STATE_BACKEND=dynamodb`
- `DYNAMODB_TABLE_NAME`
- `DYNAMODB_TTL_SECONDS`
- `DYNAMODB_REGION` 또는 `AWS_REGION`
- `CRAWL_MODE=playwright`
- `ALERT_KEYWORDS`
- `FMKOREA_BOARD_URL`
- `FMKOREA_BOARD_URLS`
- `REQUEST_TIMEOUT_MS`
- `MAX_PAGES_PER_POLL`
- `MAX_ITEMS_PER_POLL`
- `LOG_LEVEL`
- `DRY_RUN`
- notifier 관련 환경변수
- browser pack 관련 환경변수

---

### 7-3. Scheduler 설정

주기 실행은 EventBridge Rule 또는 Scheduler로 구성한다.

기본값:
- `rate(3 minutes)`

요구사항:
- schedule expression은 parameterized
- 활성/비활성 옵션 제공 가능하면 좋음
- 기본은 활성화

---

## 8. 패키징/배포 스크립트 요구사항

### 8-1. 배포 흐름

배포 스크립트는 최소 아래를 수행해야 한다.

1. 애플리케이션 빌드
2. Lambda zip 생성
3. browser pack 또는 layer 준비
4. zip 업로드
5. CloudFormation deploy/update
6. 완료 후 함수명/로그경로/스케줄 정보 출력

권장 파일명:
- `scripts/deploy-lambda-playwright.sh`

### 8-2. 딸깍 배포 UX

최소 아래 수준이어야 한다.

```bash
export SLACK_WEBHOOK_URL="..."
export ALERT_KEYWORDS="삼다수,요기요"
./scripts/deploy-lambda-playwright.sh
```

운영자 입장에서 이 명령으로 아래가 가능해야 한다.

- package build
- browser pack 참조 준비
- CloudFormation deploy
- Lambda 업데이트
- EventBridge 연결

---

## 9. 비밀값/설정 주입 요구사항

### 9-1. 1차 기준

1차는 **CloudFormation parameter + Lambda env 주입** 방식을 허용한다.

비밀값:
- `SLACK_WEBHOOK_URL`
- `TELEGRAM_BOT_TOKEN`
- `TELEGRAM_CHAT_ID`
- `DISCORD_WEBHOOK_URL`

요구사항:
- 템플릿 parameter는 `NoEcho: true`
- 코드/레포에 실값 하드코딩 금지

권장:
- 추후 Secrets Manager 확장 가능성은 열어둔다
- 1차 완료 기준에 Secrets Manager 강제는 아님

---

## 10. 문서 산출물 요구사항

워커는 아래 문서를 제공해야 한다.

- `docs/lambda-playwright-deploy.md`

문서 포함 항목:
- 사전 준비물
- 최초 배포 방법
- 재배포 방법
- browser pack 공급 방식 설명
- Layer 또는 S3 전략 설명
- 주요 parameter 설명
- 수동 invoke 방법
- 로그 확인 방법
- dry-run 배포 방법
- stack 삭제 방법

---

## 11. 테스트 요구사항

### 11-1. 반드시 통과해야 할 것

- `npm run build`
- `npm run lint`
- `npm test`

### 11-2. 반드시 검증할 시나리오

- fresh post는 1회 전송
- duplicate claim은 skip
- 전송 실패 시 unclaim
- Redis 없이 Lambda 경로 정상 실행
- Redis 경로 K8s에서 기존처럼 동작
- DynamoDB logical expiration이 TTL 지연과 무관하게 동작
- Lambda handler가 invocation마다 독립적으로 정상 종료
- Playwright Lambda 경로가 packaging configuration 기준으로 깨지지 않음

### 11-3. 배포판 검증

최소 아래 검증이 가능해야 한다.

- CloudFormation template validation
- Lambda zip build success
- browser pack reference validation
- CloudFormation stack deploy success
- Lambda 수동 invoke success
- CloudWatch 로그 확인 가능

---

## 12. 완료 기준 (Definition of Done)

아래를 모두 만족해야 완료다.

1. 기존 K8s 경로 회귀 없음
2. Playwright Lambda zip 경로가 추가됨
3. Lambda는 `playwright-core` + `@sparticuz/chromium-min` 기준으로 동작 가능
4. Lambda는 3분 주기로 실행 가능
5. 상태 저장은 DynamoDB로 동작
6. 비VPC 환경에서 정상 동작
7. build/lint/test 통과
8. CloudFormation 배포 가능
9. 운영자가 문서만 보고 최초 배포 가능
10. 비밀값 하드코딩 없음
11. invocation 종료 시 리소스 정리됨

---

## 13. 명시적 제외 범위

아래는 이번 완료 조건에 포함하지 않는다.

- ECR container image 전략
- browser warm reuse 최적화
- VPC 연동
- Secrets Manager 강제 적용
- GitHub Actions 자동 배포
- 멀티 스테이지 완전 분리
- DLQ/SNS 고도화

---

## 14. 워커 지시용 요약

> 기존 K8s + Redis 경로는 유지하고, Redis 없이도 동작하는 Lambda + DynamoDB 경로를 유지한 채, Playwright 실행을 위해 zip 기반 Lambda 경로를 `playwright-core` + `@sparticuz/chromium-min` 전략으로 보강하라.
> Chromium 본체는 함수 zip 안에 직접 넣지 말고 Layer 또는 S3 browser pack 방식으로 외부화하라.
> Lambda는 비VPC, Node 24, 메모리 2048MB, timeout 60초, reserved concurrency 1, EventBridge 3분 주기 실행 구조로 구성하라.
> 배포는 CloudFormation 기반으로 유지하고, 운영자가 단일 deploy script로 package/build/deploy를 수행할 수 있어야 한다.
> 상태 저장은 DynamoDB를 사용하고 TTL은 cleanup 용도로만 사용하며 logical expiration은 앱 로직에서 처리하라.
> build/lint/test와 배포판 검증을 모두 통과해야 한다.
