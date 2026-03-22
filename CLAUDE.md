# CLAUDE.md

This file provides guidance to Claude Code (claude.ai/code) when working with code in this repository.

## Project Overview

FMKorea 핫딜 게시판 모니터. Playwright/HTTP로 크롤링하여 키워드 매칭 게시글을 Slack/Telegram/Discord로 알림 전송. Node.js + TypeScript, Kubernetes 배포 지원.

## Commands

```bash
npm run build          # TypeScript 빌드 (tsc -> dist/)
npm run dev            # tsx watch 개발 모드
npm test               # 빌드 후 Node test runner (tests/*.js)
npm run lint           # tsc --noEmit 타입 체크
npm run run:local      # 로컬 단발 실행 (DRY_RUN=true, RUN_ONCE=true)
npm run run:once:local # 키워드 테스트 단발 실행
npm run docker:build   # Docker 이미지 빌드
npm run docker:test    # Docker로 단발 실행 테스트
```

테스트는 `dist/` 빌드 결과물을 import하므로 반드시 빌드 후 실행해야 함. `npm test`가 빌드를 포함함.

## Architecture

ESM (`"type": "module"`) 프로젝트. TypeScript 소스는 `src/`, 빌드 출력은 `dist/`.

**핵심 흐름**: `index.ts` (main loop) → `monitor.ts` (크롤링+파싱) → `notifier.ts` (알림 전송)

- **`config.ts`** — 환경변수 기반 설정. `getConfig()`이 모든 설정을 파싱하여 `AppConfig` 반환. `dotenv` 사용.
- **`monitor.ts`** — Cheerio 기반 HTML 파싱. `fetchLatestPosts()`가 보드 URL들을 순회하며 게시글 추출. 크롤링 모드: `playwright` (기본) / `http` / `auto`. 한국어 상대 날짜 파싱 (`3분전`, `어제` 등) 내장. `keywordMatchesTitle()`은 NFKC 정규화 + 구두점 제거 후 매칭.
- **`index.ts`** — 메인 루프. `pollOnce()`가 크롤링→키워드 매칭→중복 체크→알림 전송을 한 사이클로 수행. 첫 실행과 이후 실행에서 lookback/페이지 수가 다름 (`startup*` vs 일반). 시그널 핸들링(SIGTERM/SIGINT)으로 graceful shutdown.
- **`stateStore.ts`** — 중복 알림 방지. 3가지 모드: 메모리(기본), 파일(`USE_FILE_STATE`), Redis(`USE_REDIS_STATE`). Redis 모드에서 `claim()`은 `SET NX`로 원자적 잠금.
- **`leaderElection.ts`** — Kubernetes Lease API 기반 리더 선출. 다중 Pod 환경에서 리더만 폴링 수행.
- **`notifier.ts`** — Slack webhook, Telegram Bot API, Discord webhook 동시 전송. `DRY_RUN=true`면 로그만 출력.
- **`logger.ts`** — JSON 구조화 로깅. `event` 필드로 로그 종류 식별.
- **`types.ts`** — `HotdealPost` 타입 정의 (title, link, id, publishedAt).

## Key Patterns

- 모든 import는 `.js` 확장자 사용 (ESM 요구사항): `import { foo } from './bar.js'`
- 테스트는 `tests/*.js`로 작성 (Node.js built-in test runner, `node:test` + `node:assert/strict`). `dist/` 빌드 결과물을 import함.
- 보드 URL 실패 시 자동으로 모바일/데스크톱 미러 URL 생성하여 fallback (`deriveBoardMirrors`)
- 게시글 ID는 URL에서 숫자 추출하여 `fmkorea-post:{number}` 형태로 정규화 (`normalizePostId`)
- anti-bot 차단 감지: `에펨코리아 보안 시스템`, `ddosCheckOnly` 등의 마커 확인
- 환경변수 참조는 `getEnv()` → `toBoolean()`/`toInt()`/`splitKeywords()` 헬퍼 사용

## Deployment

- Docker: `node:22-bookworm-slim` 기반, 시스템 Chromium 사용 (`PLAYWRIGHT_EXECUTABLE_PATH=/usr/bin/chromium`)
- K8s: `scripts/apply-k8s-from-config.sh`로 배포. `config/` 디렉토리에서 시크릿 값 읽음.
- CI: GitHub Actions, `main` push 시 Docker Hub에 `montkim9/fmkorea-hotdeal-monitor` 이미지 push
