# Runtime Behavior (K8s 기준)

이 문서는 현재 배포 설정 기준으로 모니터가 어떤 주기로 수집/분석/발송하는지,
중복 방지와 차단 대응을 어떻게 처리하는지 설명합니다.

## 1) 실행 주기와 수집 범위

- 기본 폴링 주기: `REQUEST_INTERVAL_MS=180000` (3분)
- 첫 실행(시작 직후):
  - `STARTUP_LOOKBACK_HOURS=168` (최근 168시간)
  - `STARTUP_MAX_PAGES_PER_POLL=8`
  - `STARTUP_MAX_ITEMS_PER_POLL=120`
- 이후 주기 실행:
  - `LOOKBACK_HOURS=3` (최근 3시간)
  - `MAX_PAGES_PER_POLL=1`
  - `MAX_ITEMS_PER_POLL=30`

즉, 시작 직후에는 넓게 훑고(부트스트랩), 정상 운영 구간에서는 가볍고 빠르게 반응하도록 동작합니다.

## 2) 처리 파이프라인

1. Playwright로 FMKorea 목록 페이지를 수집
2. Cheerio로 게시글/링크/시간 파싱
3. 키워드(`ALERT_KEYWORDS`) 매칭
4. 최근 시간 윈도우(첫 실행 168h / 이후 3h)로 알림 후보 필터
5. Redis 상태키를 기준으로 신규 여부 확인
6. Slack/Telegram webhook 발송

## 3) 중복 방지

- 저장소: Redis (`USE_REDIS_STATE=true`)
- 키 prefix: `REDIS_KEY_PREFIX=hotdeal:seen:`
- TTL: `REDIS_TTL_SECONDS=604800` (7일)

중복 방지 방식은 `claim -> send -> keep/unclaim` 구조입니다.

- 성공적으로 1개 이상 채널 전송되면 key 유지
- 전송 예외/전송 대상 없음/전체 실패면 `unclaim`으로 key 해제 후 다음 루프 재시도

## 4) HA와 Leader Election

- Kubernetes Lease 기반 리더 선출 사용
- `LEADER_ELECTION_ENABLED=true`
- `LEADER_ELECTION_LEASE_NAME=fmkorea-hotdeal-monitor`
- `LEADER_ELECTION_LEASE_DURATION_SECONDS=30`
- `LEADER_ELECTION_RENEW_INTERVAL_MS=10000`

여러 Pod가 떠도 리더만 폴링 루프를 실행합니다.
리더 장애 시 lease 만료 후 다른 Pod가 승계합니다.

필요 RBAC은 `k8s/rbac.yaml`에 포함되어 있습니다.

## 5) 차단(anti-bot) 대응

다음 조합으로 차단 페이지 대응력을 높입니다.

- 모바일/데스크톱 미러 URL 후보 자동 시도
- `ddosCheckOnly=1` 후보 URL 추가 시도
- User-Agent 후보 순환
- Playwright context에서 locale/timezone/header 적용
- 이미지/미디어/폰트 리소스 차단으로 로딩 부담 완화

## 6) 로그 레벨

- `LOG_LEVEL=debug|info|error`
- 운영 권장: `LOG_LEVEL=info`

레벨별 출력 기준:

- `debug`: 상세 파싱 요약/DRY-RUN 상세
- `info`: 폴링 시작/대기/정상 알림/상태 전환
- `error`: 전송 실패, Redis 오류, 치명 오류

## 7) 배포 체크포인트

- Deployment는 `imagePullPolicy: Always`로 최신 태그를 매번 pull
- Redis + Lease RBAC를 먼저 적용한 뒤 앱 Deployment 적용
- Secret/ConfigMap 반영 후 Pod 재시작으로 최신 설정 반영
