# fmkorea-hotdeal-monitor

FMKorea 핫딜 게시판을 Playwright 기반으로 주기적으로 크롤링해서, 설정한 키워드가 제목에 포함될 때
Slack 또는 Telegram으로 알림을 보내는 Node.js 기반 모니터입니다.

## 주요 기능

- FMKorea 핫딜 게시판 페이지를 일정 간격으로 조회
- 키워드 매칭(기본 제목 기준)으로 신규 게시글 감지
- 중복 알림 방지를 위한 게시글 ID 저장
- Redis + Kubernetes Lease 기반 중복 방지/리더 선출(HA)
- Slack Webhook / Telegram Bot API 중복 전송 지원
- `.env` 및 Kubernetes 환경변수 기반 설정
- Dockerfile + Kubernetes 배포 템플릿
- GitHub Actions로 빌드 후 Docker Hub에 푸시
- 기본은 BP(메모리 상태) 모드, `DRY_RUN`/`USE_FILE_STATE`를 통해 안전한 사전 점검과
  중복 알림 저장 방식 전환 지원

## 시작 방법

1. 의존성 설치

```bash
npm install
```

2. `.env` 작성

```bash
cp .env.example .env
```

3. 로컬 실행(권장)

```bash
./scripts/run-local.sh
```

스크립트는 다음을 수행합니다.

- `.env`가 없으면 `.env.example`을 복사
- TypeScript 빌드
- 컨테이너처럼 동작하는 단발 실행(`RUN_ONCE=true`) 및 DRY_RUN 기본 동작
- startup 프로필(첫 사이클 5페이지 수집)로 실행

원하면 수동으로 실행도 가능합니다.

```bash
npm run build
RUN_ONCE=true DRY_RUN=true npm start
```

4. 테스트

```bash
npm test
```

테스트는 TypeScript 빌드 후 `tests/*.js` 기반의 Node 테스트 스위트를 실행합니다.

## 로컬 Docker 테스트

```bash
npm run docker:test
```

도커 테스트는 이미지를 빌드하고 `.env`를 주입해 `RUN_ONCE=true` + `DRY_RUN=true`로
한 번 실행해 컨테이너에서 보이는 로그를 바로 확인합니다.

현재 Dockerfile은 경량화를 위해 Playwright 번들 브라우저를 이미지에 내장하지 않고,
컨테이너의 시스템 Chromium(`PLAYWRIGHT_EXECUTABLE_PATH=/usr/bin/chromium`)을 사용합니다.

참고: IP/지역에 따라 fmkorea가 430/429 차단 페이지를 반환하면 즉시 추적이 중단됩니다.
이때는 `FMKOREA_BOARD_URLS`에 다른 접근 가능한 URL을 넣어 우회 후보를 추가하세요.
우선적으로는 `https://m.fmkorea.com/hotdeal` 또는 해당 국가 IP에서 동작하는 보조 도메인을 추가해 보세요.
실제 실행에서는 기준 URL 실패 시 자동으로 모바일/데스크톱 미러를 같이 시도하도록 구성되어 있습니다.

기본 크롤링 모드는 `CRAWL_MODE=playwright`입니다.
필요하면 `http` 또는 `auto`로 바꿔서 실행할 수 있습니다.

운영 동작(주기/필터/리더 선출/중복 방지) 상세는 `docs/runtime-behavior.md`를 참고하세요.

현재 런타임 동작은 고정입니다.

- startup: 5페이지, 최대 120개 게시글 분석
- recurring: 1페이지, 최대 30개 게시글 분석


## 환경 변수

| 변수 | 설명 |
|---|---|
| `FMKOREA_BOARD_URL` | 모니터링할 게시판 URL (기본값: `https://m.fmkorea.com/hotdeal`) |
| `FMKOREA_BOARD_URLS` | 추가 후보 게시판 URL(쉼표 구분) — 첫 URL 실패 시 순차 시도 |
| `CRAWL_MODE` | `playwright` / `auto` / `http` (기본 `playwright`) |
| `ALERT_KEYWORDS` | 콤마 구분 키워드 (기본: `삼다수,요기요`) |
| `REQUEST_INTERVAL_MS` | 조회 주기 (밀리초, 기본: `180000`) |
| `REQUEST_TIMEOUT_MS` | HTTP 타임아웃 (밀리초, 기본: `20000`) |
| `STATE_FILE_PATH` | 중복 방지 저장 경로 (기본: 빈 값, file-state 비활성) |
| `USE_FILE_STATE` | `true`면 `STATE_FILE_PATH`에 상태 저장, 기본은 `false` |
| `USE_REDIS_STATE` | `true`면 Redis를 중복 방지 상태 저장소로 사용 |
| `REDIS_URL` | Redis 연결 URL (예: `redis://fmkorea-hotdeal-redis:6379`) |
| `REDIS_KEY_PREFIX` | Redis key prefix (기본: `hotdeal:seen:`) |
| `REDIS_TTL_SECONDS` | Redis 상태 key TTL (초, 기본: `604800` = 7일) |
| `LEADER_ELECTION_ENABLED` | Kubernetes Lease 기반 leader election 사용 여부 (`true`/`false`) |
| `LEADER_ELECTION_LEASE_NAME` | Lease 리소스 이름 (기본: `fmkorea-hotdeal-monitor`) |
| `LEADER_ELECTION_NAMESPACE` | Lease를 관리할 namespace (기본: `POD_NAMESPACE` 또는 `default`) |
| `LEADER_ELECTION_IDENTITY` | 리더 식별자 (기본: `POD_NAME` 또는 `monitor-<pid>`) |
| `LEADER_ELECTION_LEASE_DURATION_SECONDS` | Lease 만료 시간(초, 기본: `30`) |
| `LEADER_ELECTION_RENEW_INTERVAL_MS` | Lease 갱신 주기(ms, 기본: `10000`) |
| `LOG_LEVEL` | 로그 레벨 (`debug` / `info` / `error`, 기본 `info`) |
| `DRY_RUN` | `true`면 알림 전송 없이 로그만 출력 |
| `RUN_ONCE` | `true`면 한 번만 실행 후 종료 |
| `USER_AGENT` | HTTP 요청 User-Agent |
| `PLAYWRIGHT_WS_ENDPOINT` | 원격 Playwright 브라우저 WebSocket endpoint(선택) |
| `PLAYWRIGHT_EXECUTABLE_PATH` | 로컬 Chromium/Chrome 실행 파일 경로(선택) |
| `PLAYWRIGHT_HEADLESS` | Playwright 헤드리스 모드 (`true`/`false`) |
| `PLAYWRIGHT_NAV_TIMEOUT_MS` | Playwright 페이지 로딩 타임아웃(ms) |
| `PLAYWRIGHT_WAIT_AFTER_LOAD_MS` | DOM 로딩 후 추가 대기(ms) |
| `SLACK_WEBHOOK_URL` | Slack Incoming Webhook URL |
| `TELEGRAM_BOT_TOKEN` | Telegram Bot Token |
| `TELEGRAM_CHAT_ID` | Telegram Chat ID |
| `POST_SELECTOR` | 게시글 항목 선택자(선택) |
| `LINK_SELECTOR` | 링크 선택자(선택) |
| `TITLE_SELECTOR` | 제목 선택자(선택) |

Slack 또는 Telegram 둘 다 설정하면 둘 다 전송됩니다.

## Kubernetes 배포

### 1) Redis + Leader Election 모드(권장)

Redis TTL(기본 7일) 동안 중복 상태가 유지되며, 다중 Pod에서도 리더 1개만 폴링을 수행합니다.
먼저 notifier secret을 생성한 뒤, 매니페스트를 순서대로 apply 하세요.

```bash
kubectl -n default create secret generic fmkorea-hotdeal-monitor-secret \
  --from-literal=slack-webhook-url="${SLACK_WEBHOOK_URL:-}" \
  --from-literal=discord-webhook-url="${DISCORD_WEBHOOK_URL:-}" \
  --from-literal=telegram-bot-token="${TELEGRAM_BOT_TOKEN:-}" \
  --from-literal=telegram-chat-id="${TELEGRAM_CHAT_ID:-}" \
  --dry-run=client -o yaml | kubectl -n default apply -f -

kubectl -n default apply -f k8s/redis.yaml
kubectl -n default apply -f k8s/rbac.yaml
kubectl -n default apply -f k8s/configmap.yaml
kubectl -n default apply -f k8s/pdb.yaml
kubectl -n default apply -f k8s/deployment.yaml
```

네임스페이스를 지정하려면 `-n <namespace>`를 같은 방식으로 바꿔 적용하면 됩니다.
예: `-n hotdeal`.

실제 apply 없이 검증만 하려면 아래처럼 client dry-run을 사용하세요.

```bash
kubectl -n default apply --dry-run=client -f k8s/redis.yaml
kubectl -n default apply --dry-run=client -f k8s/rbac.yaml
kubectl -n default apply --dry-run=client -f k8s/configmap.yaml
kubectl -n default apply --dry-run=client -f k8s/pdb.yaml
kubectl -n default apply --dry-run=client -f k8s/deployment.yaml
```

`k8s/configmap.yaml`의 `ALERT_KEYWORDS`를 운영 목적에 맞게 수정하세요.
`k8s/redis.yaml`은 Redis를 StatefulSet + PVC로 배포합니다.
버전/호환성 관리를 위해 annotation(`component-version`, `compat-major`)을 넣어두었고, `updateStrategy: OnDelete`로 설정되어 있어 이미지 태그/annotation 변경만으로는 자동 재시작되지 않습니다.
즉 메이저 호환 정책 안에서 버전 값을 올리더라도 운영자가 Pod를 명시적으로 재시작하기 전까지는 기존 Redis 인스턴스를 계속 사용합니다.

### 2) 파일 상태 저장 모드(선택)

중복 감지 상태를 컨테이너 재시작 간 유지하고 싶으면 파일 기반 상태 모드로 배포하세요.

```bash
kubectl -n default apply -f k8s/rbac.yaml
kubectl -n default apply -f k8s/configmap.yaml
kubectl -n default apply -f k8s/pdb.yaml
kubectl -n default apply -f k8s/pvc.yaml
kubectl -n default apply -f k8s/deployment-with-file-state.yaml
```

운영에서 `CONFIG` 기준으로 `USE_FILE_STATE=true`를 보장하면 됩니다.
`deployment-with-file-state.yaml`은 Redis 대신 파일 상태 저장을 쓰도록 `USE_REDIS_STATE=false`를 고정합니다.

`deployment.yaml`의 이미지 태그(`docker.io/montkim9/fmkorea-hotdeal-monitor:latest`)는
실제 레포지토리 경로에 맞게 수정하세요.

`latest` 태그를 사용할 때는 `imagePullPolicy: Always`로 설정되어 있어 매 배포 시 최신 이미지를 pull 합니다.

## GitHub Actions

`.github/workflows/ci.yml`는 `main` 브랜치 push 시 Docker build 후 Docker Hub로 push 합니다.
`workflow_dispatch`로 수동 실행할 때는 `main` 브랜치에서만 push 하고,
다른 브랜치에서는 build만 수행합니다.

워크플로우는 빌드 시작 전에 Docker Hub 로그인 검증을 먼저 수행합니다.
Docker Hub 사용자명은 `montkim9`로 고정되어 있습니다.

GitHub Repository Secrets에 아래 항목을 설정하세요.
- `docker_password`

참고: 기존 대문자 시크릿(`DOCKER_PASSWORD`)도 fallback으로 지원합니다.

푸시 태그
- `montkim9/fmkorea-hotdeal-monitor:latest`
- `montkim9/fmkorea-hotdeal-monitor:<commit sha 6자리>`

빌드 아키텍처는 `linux/amd64`(x86_64) 단일로 설정되어 있습니다.

## 컨테이너 로그 예시

```
{"event":"monitor.matches.summary","cycleMode":"startup","pageDepth":5,"result":{"matched":2,"unparseableDate":1}}
{"event":"monitor.cycle.pipeline","options":{"cycleMode":"startup","pageDepth":5,"itemLimit":120},"result":{"fetched":120,"keywordMatched":2,"candidates":2,"unparseableDate":1}}
```

pod 재시작 직후 첫 조회는 startup 프로필(5페이지)로 동작하고,
이후 주기 조회는 recurring 프로필(1페이지)로 동작합니다.

파싱이 실패해 `publishedAt`이 비어 있거나 잘못되면
`unparseableDate` 필드로 함께 기록됩니다.

`config/telegram` 또는 `config/telegram.env`를 사용할 때 Telegram 실제 전송을 하려면
`TELEGRAM_BOT_TOKEN`과 `TELEGRAM_CHAT_ID`가 모두 있어야 합니다.

`TELEGRAM_CHAT_ID`가 없으면 `config/chatid`의 첫 유효 라인을 자동으로 읽습니다.
`config/chatid`는 `TELEGRAM_CHAT_ID=...` 또는 값 단독 한 줄 형식 둘 다 지원합니다.
채널 ID가 `100...` 형태로 저장되어 있으면 실행 시 `-100...` 형태로 자동 보정합니다.

- raw 형식: 1줄 `token`, 2줄 `chat_id`
- key=value 형식: `TELEGRAM_BOT_TOKEN=...`, `TELEGRAM_CHAT_ID=...`

- `MATCHED`: 현재 수집한 페이지 범위 안에서 키워드가 매칭된 게시물
- `UNPARSEABLE_DATE`: 날짜 파싱 실패/누락 매칭 게시물
- `차단/접근차단` 메시지: FMKorea 차단 응답이 감지된 상태에서 결과 신뢰도가 낮습니다.

## 일회성 키워드 테스트 (로컬/도커)

```bash
# 로컬 단발 테스트 (기본 키워드: 삼다수,요기요)
npm run run:once:local

# 도커 단발 테스트 (기본 키워드: 삼다수,요기요)
npm run run:once:docker
```

원하면 키워드를 바꿔 실행할 수 있습니다.

```bash
ALERT_KEYWORDS="삼다수" npm run run:once:local
ALERT_KEYWORDS="요기요" npm run run:once:docker
```

## 라이선스

MIT
