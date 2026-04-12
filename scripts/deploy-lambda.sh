#!/usr/bin/env bash
# ──────────────────────────────────────────────────────────────
# deploy-lambda.sh — CloudFormation 기반 Lambda 원클릭 배포
#
# 사용법:
#   # 시크릿 설정
#   export SLACK_WEBHOOK_URL="https://hooks.slack.com/..."
#   export TELEGRAM_BOT_TOKEN="123:ABC..."
#   export TELEGRAM_CHAT_ID="-100..."
#   export ALERT_KEYWORDS="삼다수,요기요,펩시"
#
#   # 배포
#   ./scripts/deploy-lambda.sh
#
# 환경변수:
#   STACK_NAME     (default: hotdeal-monitor-lambda)
#   AWS_REGION     (default: ap-northeast-2)
#   DEPLOY_BUCKET  (default: auto-generated)
# ──────────────────────────────────────────────────────────────
set -euo pipefail
cd "$(dirname "$0")/.."

STACK_NAME="${STACK_NAME:-hotdeal-monitor-lambda}"
AWS_REGION="${AWS_REGION:-ap-northeast-2}"
DEPLOY_BUCKET="${DEPLOY_BUCKET:-}"

for cmd in aws node npm zip; do
  if ! command -v "$cmd" &>/dev/null; then
    echo "ERROR: '$cmd' not found" >&2; exit 1
  fi
done

echo "============================================"
echo " Hotdeal Monitor — Lambda Deployment"
echo " Stack:  $STACK_NAME"
echo " Region: $AWS_REGION"
echo "============================================"

# ── 1. Build ──
echo "==> [1/4] Building TypeScript..."
npm run build

# ── 2. Package ──
echo "==> [2/4] Packaging Lambda zip..."
WORK_DIR=$(mktemp -d)
trap 'rm -rf "$WORK_DIR" /tmp/hotdeal-lambda.zip 2>/dev/null' EXIT

cp -r dist "$WORK_DIR/"
cp package.json "$WORK_DIR/"
[ -f package-lock.json ] && cp package-lock.json "$WORK_DIR/"

node scripts/prepare-lambda-package.cjs "$WORK_DIR/package.json"
(cd "$WORK_DIR" && npm install --omit=dev --ignore-scripts 2>/dev/null)
(cd "$WORK_DIR" && zip -rq /tmp/hotdeal-lambda.zip dist/ node_modules/ package.json)

echo "    Size: $(du -h /tmp/hotdeal-lambda.zip | cut -f1)"

# ── 3. Upload to S3 ──
echo "==> [3/4] Uploading to S3..."
ACCOUNT_ID=$(aws sts get-caller-identity --query Account --output text --region "$AWS_REGION")
if [ -z "$DEPLOY_BUCKET" ]; then
  DEPLOY_BUCKET="hotdeal-deploy-${ACCOUNT_ID}-${AWS_REGION}"
fi

if ! aws s3api head-bucket --bucket "$DEPLOY_BUCKET" --region "$AWS_REGION" 2>/dev/null; then
  echo "    Creating bucket: $DEPLOY_BUCKET"
  if [ "$AWS_REGION" = "us-east-1" ]; then
    aws s3api create-bucket --bucket "$DEPLOY_BUCKET" --region "$AWS_REGION"
  else
    aws s3api create-bucket --bucket "$DEPLOY_BUCKET" --region "$AWS_REGION" \
      --create-bucket-configuration LocationConstraint="$AWS_REGION"
  fi
fi

S3_KEY="lambda/${STACK_NAME}/$(date +%Y%m%d-%H%M%S).zip"
aws s3 cp /tmp/hotdeal-lambda.zip "s3://${DEPLOY_BUCKET}/${S3_KEY}" \
  --region "$AWS_REGION" --quiet
echo "    s3://${DEPLOY_BUCKET}/${S3_KEY}"

# ── 4. Deploy CloudFormation ──
echo "==> [4/4] Deploying stack..."
PARAMS=("CodeS3Bucket=$DEPLOY_BUCKET" "CodeS3Key=$S3_KEY")
[ -n "${ALERT_KEYWORDS:-}" ]      && PARAMS+=("AlertKeywords=$ALERT_KEYWORDS")
[ -n "${SLACK_WEBHOOK_URL:-}" ]    && PARAMS+=("SlackWebhookUrl=$SLACK_WEBHOOK_URL")
[ -n "${SLACK_BOT_TOKEN:-}" ]      && PARAMS+=("SlackBotToken=$SLACK_BOT_TOKEN")
[ -n "${SLACK_CHANNEL:-}" ]        && PARAMS+=("SlackChannel=$SLACK_CHANNEL")
[ -n "${TELEGRAM_BOT_TOKEN:-}" ]   && PARAMS+=("TelegramBotToken=$TELEGRAM_BOT_TOKEN")
[ -n "${TELEGRAM_CHAT_ID:-}" ]     && PARAMS+=("TelegramChatId=$TELEGRAM_CHAT_ID")
[ -n "${DISCORD_WEBHOOK_URL:-}" ]  && PARAMS+=("DiscordWebhookUrl=$DISCORD_WEBHOOK_URL")
[ -n "${SCHEDULE_RATE:-}" ]        && PARAMS+=("ScheduleExpression=$SCHEDULE_RATE")
[ -n "${DRY_RUN:-}" ]              && PARAMS+=("DryRun=$DRY_RUN")
[ -n "${LOG_LEVEL:-}" ]            && PARAMS+=("LogLevel=$LOG_LEVEL")

aws cloudformation deploy \
  --template-file infra/cloudformation.yaml \
  --stack-name "$STACK_NAME" \
  --region "$AWS_REGION" \
  --capabilities CAPABILITY_NAMED_IAM \
  --parameter-overrides "${PARAMS[@]}" \
  --no-fail-on-empty-changeset

# ── Done ──
FUNC="${STACK_NAME}-poll"
echo ""
echo "============================================"
echo " Done!"
echo "============================================"
echo ""
echo "  Lambda:   $FUNC"
echo "  DynamoDB: ${STACK_NAME}-seen-posts"
echo "  Logs:     /aws/lambda/$FUNC"
echo ""
echo "Commands:"
echo "  # 수동 실행"
echo "  aws lambda invoke --function-name $FUNC --region $AWS_REGION /dev/stdout"
echo ""
echo "  # 로그 확인"
echo "  aws logs tail /aws/lambda/$FUNC --region $AWS_REGION --follow"
echo ""
echo "  # 스케줄 끄기"
echo "  aws events disable-rule --name ${STACK_NAME}-schedule --region $AWS_REGION"
echo ""
echo "  # 스택 삭제 (DynamoDB 테이블은 보존됨)"
echo "  aws cloudformation delete-stack --stack-name $STACK_NAME --region $AWS_REGION"
