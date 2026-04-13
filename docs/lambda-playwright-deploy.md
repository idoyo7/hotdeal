# Lambda Playwright 배포 가이드

## 개요

Playwright를 사용하는 Lambda 배포. Chromium 바이너리는 Lambda Layer로 공급하고, 함수 코드에는 `playwright-core` + `@sparticuz/chromium-min`만 포함하여 zip 크기를 최소화합니다.

**Layer 방식을 선택한 이유:**
- S3 방식 대비 cold start 시 `/tmp` 다운로드 불필요
- CloudFormation에서 선언적으로 버전 관리 가능
- 함수 zip과 독립적으로 Layer 업데이트 가능

## 사전 요구사항

- AWS CLI (인증 설정 완료)
- Node.js 20+
- zip

## 최초 배포

```bash
# 시크릿 설정
export SLACK_WEBHOOK_URL="https://hooks.slack.com/services/..."
export ALERT_KEYWORDS="삼다수,요기요,펩시"

# Playwright 모드 배포
./scripts/deploy-lambda-playwright.sh
```

스크립트가 하는 일:
1. TypeScript 빌드
2. Lambda 함수 zip 패키징 (playwright-core + chromium-min 포함)
3. Chromium Layer zip 빌드 (@sparticuz/chromium)
4. S3 업로드 (함수 zip + Layer zip)
5. CloudFormation 배포 (Lambda + Layer + DynamoDB + EventBridge)

## 코드만 업데이트 (Layer 재사용)

Chromium Layer는 변경이 드물므로, 코드만 업데이트할 때는 Layer 빌드를 건너뛸 수 있습니다:

```bash
SKIP_LAYER=true ./scripts/deploy-lambda-playwright.sh
```

## HTTP 모드로 전환

Playwright 없이 HTTP-only로 돌아가려면:

```bash
./scripts/deploy-lambda.sh
```

동일한 CloudFormation 템플릿을 사용하며, Layer 파라미터가 비어 있으면 Layer 없이 배포됩니다.

## 생성되는 AWS 리소스

| 리소스 | 설명 |
|---|---|
| Lambda Function | `{stack}-poll`, 2GB, 60s, concurrency 1, 비VPC |
| Lambda Layer | `{stack}-chromium`, @sparticuz/chromium (~60MB) |
| DynamoDB Table | `{stack}-seen-posts`, PAY_PER_REQUEST, TTL 활성화 |
| EventBridge Rule | 3분 주기 Lambda 트리거 |
| CloudWatch Log Group | 14일 보관 |
| IAM Role | DynamoDB + CloudWatch 최소 권한 |

## 환경변수 옵션

| 변수 | 기본값 | 설명 |
|---|---|---|
| `STACK_NAME` | `hotdeal-monitor-lambda` | CloudFormation 스택 이름 |
| `AWS_REGION` | `ap-northeast-2` | AWS 리전 |
| `DEPLOY_BUCKET` | 자동 생성 | S3 배포 버킷 |
| `SKIP_LAYER` | `false` | Layer 빌드 건너뛰기 |
| `ALERT_KEYWORDS` | (빈 값) | 알림 키워드 |
| `SLACK_WEBHOOK_URL` | | Slack webhook |
| `SLACK_BOT_TOKEN` | | Slack bot token |
| `SLACK_CHANNEL` | | Slack channel ID |
| `TELEGRAM_BOT_TOKEN` | | Telegram bot token |
| `TELEGRAM_CHAT_ID` | | Telegram chat ID |
| `DISCORD_WEBHOOK_URL` | | Discord webhook |
| `SCHEDULE_RATE` | `rate(3 minutes)` | 실행 주기 |
| `DRY_RUN` | `false` | dry-run 모드 |
| `LOG_LEVEL` | `info` | 로그 레벨 |

## 운영 명령어

```bash
# 수동 실행
aws lambda invoke \
  --function-name hotdeal-monitor-lambda-poll \
  --region ap-northeast-2 /dev/stdout

# 로그 확인
aws logs tail /aws/lambda/hotdeal-monitor-lambda-poll \
  --follow --region ap-northeast-2

# 스케줄 비활성화
aws events disable-rule \
  --name hotdeal-monitor-lambda-schedule \
  --region ap-northeast-2

# 스택 삭제 (DynamoDB 테이블은 Retain)
aws cloudformation delete-stack \
  --stack-name hotdeal-monitor-lambda \
  --region ap-northeast-2
```

## 아키텍처

```
EventBridge Rule (3min)
    │
    ▼
Lambda (비VPC, 2GB, Node 24.x, 60s)
    ├── Chromium Layer (@sparticuz/chromium)
    ├── playwright-core + chromium-min
    ├── Playwright fetch → FMKorea
    ├── DynamoDB → dedupe (public endpoint)
    └── Webhook → Slack / Telegram / Discord
```

## DRY_RUN 테스트

```bash
DRY_RUN=true ./scripts/deploy-lambda-playwright.sh

# 로그 확인 후 실제 모드로 전환
DRY_RUN=false SKIP_LAYER=true ./scripts/deploy-lambda-playwright.sh
```

## Layer 업데이트

@sparticuz/chromium 새 버전이 나오면:

```bash
# package.json에서 @sparticuz/chromium-min 버전 업데이트 후
./scripts/deploy-lambda-playwright.sh   # SKIP_LAYER 없이 → 새 Layer 빌드
```

## Chromium 경로 우선순위

1. `PLAYWRIGHT_EXECUTABLE_PATH` 환경변수 (K8s: `/usr/bin/chromium`)
2. `@sparticuz/chromium-min` → Layer에서 바이너리 감지 (Lambda)
3. playwright-core 기본 해석 (로컬 개발)
