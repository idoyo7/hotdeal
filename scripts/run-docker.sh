#!/usr/bin/env bash
set -euo pipefail

ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
cd "$ROOT"

IMAGE_NAME="${IMAGE_NAME:-fmkorea-hotdeal-monitor:test}"

if [ ! -f .env ]; then
  cp .env.example .env
  echo "[docker] .env copied from .env.example"
fi

echo "[docker] Building image: $IMAGE_NAME"
docker build -t "$IMAGE_NAME" .

echo "[docker] Running one-shot with .env + DRY_RUN on"
docker run --rm \
  --shm-size=512m \
  --env-file .env \
  -e DRY_RUN="${DRY_RUN:-true}" \
  -e RUN_ONCE="${RUN_ONCE:-true}" \
  -e SHOW_RECENT_MATCHES="${SHOW_RECENT_MATCHES:-true}" \
  -e LOOKBACK_HOURS="${LOOKBACK_HOURS:-168}" \
  -e USE_FILE_STATE="${USE_FILE_STATE:-false}" \
  -e CRAWL_MODE="${CRAWL_MODE:-playwright}" \
  -e FMKOREA_BOARD_URL="${FMKOREA_BOARD_URL:-https://m.fmkorea.com/hotdeal}" \
  -e FMKOREA_BOARD_URLS="${FMKOREA_BOARD_URLS:-https://www.fmkorea.com/hotdeal}" \
  -e ALERT_KEYWORDS="${ALERT_KEYWORDS:-삼다수,요기요}" \
  "$IMAGE_NAME"
