# Lambda 배포 가이드

## 사전 요구사항

- AWS CLI (인증 설정 완료)
- Node.js 20+
- zip

## 원클릭 배포

```bash
# 시크릿 설정
export SLACK_WEBHOOK_URL="https://hooks.slack.com/services/..."
export TELEGRAM_BOT_TOKEN="123456:ABC-DEF"
export TELEGRAM_CHAT_ID="-1001234567890"
export ALERT_KEYWORDS="삼다수,요기요,펩시"

# 배포
./scripts/deploy-lambda.sh
```

스크립트가 하는 일:
1. TypeScript 빌드
2. Lambda zip 패키징 (playwright/k8s 의존성 제외)
3. S3 업로드
4. CloudFormation 스택 배포

## 환경변수 옵션

| 변수 | 기본값 | 설명 |
|---|---|---|
| `STACK_NAME` | `hotdeal-monitor-lambda` | CloudFormation 스택 이름 |
| `AWS_REGION` | `ap-northeast-2` | AWS 리전 |
| `DEPLOY_BUCKET` | 자동 생성 | S3 배포 버킷 |
| `ALERT_KEYWORDS` | (빈 값 = 전체) | 알림 키워드 |
| `SLACK_WEBHOOK_URL` | | Slack webhook |
| `TELEGRAM_BOT_TOKEN` | | Telegram bot token |
| `TELEGRAM_CHAT_ID` | | Telegram chat ID |
| `DISCORD_WEBHOOK_URL` | | Discord webhook |
| `SCHEDULE_RATE` | `rate(3 minutes)` | 실행 주기 |
| `DRY_RUN` | `false` | dry-run 모드 |
| `LOG_LEVEL` | `info` | 로그 레벨 |

## 생성되는 AWS 리소스

| 리소스 | 설명 |
|---|---|
| Lambda Function | `{stack}-poll`, 2GB, 60s, concurrency 1, 비VPC |
| DynamoDB Table | `{stack}-seen-posts`, PAY_PER_REQUEST, TTL 활성화 |
| EventBridge Rule | 3분 주기 Lambda 트리거 |
| CloudWatch Log Group | 14일 보관 |
| IAM Role | DynamoDB + CloudWatch 최소 권한 |

## 코드만 업데이트

인프라 변경 없이 코드만 배포하려면 동일하게:

```bash
./scripts/deploy-lambda.sh
```

새 zip이 S3에 업로드되고 CloudFormation이 Lambda 코드를 업데이트합니다.

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

# 스택 삭제 (DynamoDB 테이블은 Retain으로 보존)
aws cloudformation delete-stack \
  --stack-name hotdeal-monitor-lambda \
  --region ap-northeast-2
```

## DRY_RUN 테스트

```bash
# dry-run으로 먼저 확인
DRY_RUN=true ./scripts/deploy-lambda.sh

# 로그 확인 후 실제 모드로 전환
DRY_RUN=false ./scripts/deploy-lambda.sh
```

## 아키텍처

```
EventBridge Rule (3min)
    │
    ▼
Lambda (비VPC, 2GB, Node 24.x, 60s)
    ├── HTTP fetch → FMKorea
    ├── DynamoDB → dedupe (public endpoint)
    └── Webhook → Slack / Telegram / Discord
```
