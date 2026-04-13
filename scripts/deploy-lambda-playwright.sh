#!/usr/bin/env bash
# ──────────────────────────────────────────────────────────────
# deploy-lambda-playwright.sh — Playwright Lambda 배포 (Layer 방식)
#
# 사용법:
#   export SLACK_WEBHOOK_URL="https://hooks.slack.com/..."
#   export ALERT_KEYWORDS="삼다수,요기요"
#   ./scripts/deploy-lambda-playwright.sh
#
# 환경변수:
#   STACK_NAME     (default: hotdeal-monitor-lambda)
#   AWS_REGION     (default: ap-northeast-2)
#   DEPLOY_BUCKET  (default: auto-generated)
#   SKIP_LAYER     (default: false — set to 'true' to reuse existing layer)
# ──────────────────────────────────────────────────────────────
set -euo pipefail
cd "$(dirname "$0")/.."

STACK_NAME="${STACK_NAME:-hotdeal-monitor-lambda}"
AWS_REGION="${AWS_REGION:-ap-northeast-2}"
DEPLOY_BUCKET="${DEPLOY_BUCKET:-}"
SKIP_LAYER="${SKIP_LAYER:-false}"

for cmd in aws node npm zip; do
  if ! command -v "$cmd" &>/dev/null; then
    echo "ERROR: '$cmd' not found" >&2; exit 1
  fi
done

echo "============================================"
echo " Hotdeal Monitor — Playwright Lambda Deploy"
echo " Stack:  $STACK_NAME"
echo " Region: $AWS_REGION"
echo " Mode:   playwright (Layer)"
echo "============================================"

# ── 1. Build ──
echo "==> [1/5] Building TypeScript..."
npm run build

# ── 2. Package function zip ──
echo "==> [2/5] Packaging Lambda function zip..."
WORK_DIR=$(mktemp -d)
trap 'rm -rf "$WORK_DIR" /tmp/hotdeal-lambda.zip /tmp/chromium-layer.zip 2>/dev/null' EXIT

cp -r dist "$WORK_DIR/"
cp package.json "$WORK_DIR/"
[ -f package-lock.json ] && cp package-lock.json "$WORK_DIR/"

node scripts/prepare-lambda-package.cjs "$WORK_DIR/package.json"
(cd "$WORK_DIR" && npm install --omit=dev --ignore-scripts 2>/dev/null)
(cd "$WORK_DIR" && zip -rq /tmp/hotdeal-lambda.zip dist/ node_modules/ package.json)

echo "    Function zip: $(du -h /tmp/hotdeal-lambda.zip | cut -f1)"

# ── 3. Build Chromium Layer ──
if [ "$SKIP_LAYER" = "true" ]; then
  echo "==> [3/5] Skipping layer build (SKIP_LAYER=true)"
else
  echo "==> [3/5] Building Chromium layer..."
  LAYER_DIR=$(mktemp -d)
  mkdir -p "$LAYER_DIR/nodejs"
  (cd "$LAYER_DIR/nodejs" && npm init -y --silent 2>/dev/null && npm install @sparticuz/chromium --silent 2>/dev/null)
  (cd "$LAYER_DIR" && zip -rq /tmp/chromium-layer.zip nodejs/)
  rm -rf "$LAYER_DIR"
  echo "    Layer zip: $(du -h /tmp/chromium-layer.zip | cut -f1)"
fi

# ── 4. Upload to S3 ──
echo "==> [4/5] Uploading to S3..."
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

TIMESTAMP=$(date +%Y%m%d-%H%M%S)
FUNC_S3_KEY="lambda/${STACK_NAME}/${TIMESTAMP}.zip"
aws s3 cp /tmp/hotdeal-lambda.zip "s3://${DEPLOY_BUCKET}/${FUNC_S3_KEY}" \
  --region "$AWS_REGION" --quiet
echo "    Function: s3://${DEPLOY_BUCKET}/${FUNC_S3_KEY}"

if [ "$SKIP_LAYER" = "true" ]; then
  # Reuse existing layer S3 key from current stack
  LAYER_S3_KEY=$(aws cloudformation describe-stacks \
    --stack-name "$STACK_NAME" --region "$AWS_REGION" \
    --query "Stacks[0].Parameters[?ParameterKey=='ChromiumLayerS3Key'].ParameterValue" \
    --output text 2>/dev/null || echo "")
  if [ -z "$LAYER_S3_KEY" ] || [ "$LAYER_S3_KEY" = "None" ] || [ "$LAYER_S3_KEY" = "" ]; then
    echo "ERROR: SKIP_LAYER=true but no existing layer found in stack. Run without SKIP_LAYER first." >&2
    exit 1
  fi
  echo "    Layer: reusing s3://${DEPLOY_BUCKET}/${LAYER_S3_KEY}"
else
  LAYER_S3_KEY="layers/${STACK_NAME}/chromium-${TIMESTAMP}.zip"
  aws s3 cp /tmp/chromium-layer.zip "s3://${DEPLOY_BUCKET}/${LAYER_S3_KEY}" \
    --region "$AWS_REGION" --quiet
  echo "    Layer: s3://${DEPLOY_BUCKET}/${LAYER_S3_KEY}"
fi

# ── 5. Deploy CloudFormation ──
echo "==> [5/5] Deploying stack..."
PARAMS=(
  "CodeS3Bucket=$DEPLOY_BUCKET"
  "CodeS3Key=$FUNC_S3_KEY"
  "ChromiumLayerS3Bucket=$DEPLOY_BUCKET"
  "ChromiumLayerS3Key=$LAYER_S3_KEY"
  "CrawlMode=playwright"
)
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
echo " Done! (Playwright mode)"
echo "============================================"
echo ""
echo "  Lambda:   $FUNC"
echo "  DynamoDB: ${STACK_NAME}-seen-posts"
echo "  Layer:    ${STACK_NAME}-chromium"
echo "  Logs:     /aws/lambda/$FUNC"
echo ""
echo "Commands:"
echo "  # 수동 실행"
echo "  aws lambda invoke --function-name $FUNC --region $AWS_REGION /dev/stdout"
echo ""
echo "  # 로그 확인"
echo "  aws logs tail /aws/lambda/$FUNC --region $AWS_REGION --follow"
echo ""
echo "  # 코드만 업데이트 (layer 재사용)"
echo "  SKIP_LAYER=true ./scripts/deploy-lambda-playwright.sh"
