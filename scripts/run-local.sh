#!/usr/bin/env bash
set -euo pipefail

ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
cd "$ROOT"

if [ ! -f .env ]; then
  cp .env.example .env
  echo "[local] .env copied from .env.example"
fi

export RUN_ONCE="${RUN_ONCE:-true}"
export DRY_RUN="${DRY_RUN:-true}"
export USE_FILE_STATE="${USE_FILE_STATE:-false}"
export REQUEST_INTERVAL_MS="${REQUEST_INTERVAL_MS:-300000}"
export ALERT_KEYWORDS="${ALERT_KEYWORDS:-삼다수,요기요}"
export CRAWL_MODE="${CRAWL_MODE:-playwright}"
export FMKOREA_BOARD_URL="${FMKOREA_BOARD_URL:-https://m.fmkorea.com/hotdeal}"
export FMKOREA_BOARD_URLS="${FMKOREA_BOARD_URLS:-https://www.fmkorea.com/hotdeal}"

echo "[local] RUN_ONCE=$RUN_ONCE DRY_RUN=$DRY_RUN CRAWL_MODE=$CRAWL_MODE STARTUP_PAGES=5 RECURRING_PAGES=1"

if [ "${CRAWL_MODE}" = "playwright" ] || [ "${CRAWL_MODE}" = "auto" ]; then
  if [ "${SKIP_PLAYWRIGHT_INSTALL:-false}" != "true" ]; then
    echo "[local] Ensuring Playwright Chromium is installed"
    npx playwright install chromium
  fi
fi

npm run build
npm run start
