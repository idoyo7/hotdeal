#!/usr/bin/env bash
set -euo pipefail

ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
cd "$ROOT"

export RUN_ONCE="true"
export DRY_RUN="${DRY_RUN:-true}"
export CRAWL_MODE="${CRAWL_MODE:-playwright}"
export LOOKBACK_HOURS="${LOOKBACK_HOURS:-168}"
export FMKOREA_BOARD_URL="${FMKOREA_BOARD_URL:-https://m.fmkorea.com/hotdeal}"
export FMKOREA_BOARD_URLS="${FMKOREA_BOARD_URLS:-https://www.fmkorea.com/hotdeal}"
export ALERT_KEYWORDS="${ALERT_KEYWORDS:-삼다수,요기요}"

bash scripts/run-local.sh
