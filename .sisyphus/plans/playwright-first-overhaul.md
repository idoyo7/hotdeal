# Playwright-First Overhaul: FMKorea Hotdeal Monitor

## TL;DR
> **Summary**: Replace the current HTTP-first collector with a Playwright-first (browser-rendered) acquisition pipeline to reduce 429/430/anti-bot breakages, and add deterministic, offline CI verification for the Playwright path.
> **Deliverables**:
> - Playwright-first crawler (env-controlled) with bounded budgets + backoff/circuit-breaker
> - Container/K8s runtime hardened for Chromium (/dev/shm, resources, security posture)
> - CI builds/pushes images and runs deterministic Playwright verification (no FMKorea dependency)
> - Updated scripts/docs for one-shot local/docker validation
> **Effort**: Large
> **Parallel**: YES - 3 waves
> **Critical Path**: Acquisition boundary refactor → Playwright containerization → Deterministic tests/CI → K8s hardening

## Context
### Original Request
- Overhaul the project to use Playwright for reliable “browser-like” crawling and perform thorough verification.

### Interview Summary
- Playwright should be the primary acquisition method (rendered HTML), not only a fallback.
- Preserve existing behavior: keyword matching, Slack/Telegram notifications, env-based config, Docker/K8s manifests, GitHub Actions build+push, one-shot scripts.

### Metis Review (gaps addressed)
- Treat as **Architecture**: plan explicitly covers Docker/K8s runtime constraints, CI verification, and bounded crawl budgets.
- Do not assume Playwright base images are multi-arch; plan includes explicit multi-arch strategy.
- Avoid adding stealth plugins / captcha solving; keep scope to acquisition robustness.

### Oracle Review (gaps addressed)
- Add `/dev/shm` mount strategy, explicit sandbox posture, resource requests/limits, and K8s-level guardrails.
- Add “budgeted crawl” limits to prevent runaway navigations/retries.

### Current Repo Snapshot (facts to anchor execution)
- Acquisition already supports `CRAWL_MODE=http|auto|playwright` and a Playwright path in `src/monitor.ts`, but it launches/closes a browser per candidate URL (high cost).
- Playwright dependency is currently `playwright-core` (no bundled browsers), and the Docker base is `node:22-alpine` (`Dockerfile`) — this combination is not suitable for reliable Playwright-in-container execution.
- Kubernetes manifests (`k8s/deployment.yaml`) are sized for HTTP-only workloads (64Mi/256Mi) and do not mount `/dev/shm`.
- CI workflow builds/pushes multi-arch images but does not run any Playwright-specific deterministic verification.

## Work Objectives
### Core Objective
- Make crawling resilient to typical community anti-bot responses by using Playwright-rendered HTML as the standard acquisition path.

### Deliverables
- Playwright-first acquisition module with:
  - `CRAWL_MODE=playwright` as recommended production default
  - `CRAWL_MODE=http` retained as optional lightweight mode
  - `CRAWL_MODE=auto` retained for cost-balanced operation (HTTP first, Playwright only on blocked)
- Bounded crawling budgets (time, navigations, retries) + rate limiting + circuit breaker.
- Deterministic, offline verification of Playwright path (local fixture server + browser navigation).
- Dockerfile and GH Actions updated to reliably run Playwright in containers and publish multi-arch images.
- Kubernetes manifests updated for Chromium reliability and security posture.

### Definition of Done (verifiable)
- `npm ci && npm run lint && npm test` exits 0.
- `npm run docker:test` exits 0.
- Deterministic Playwright fixture test exits 0 in CI and in Docker image.
- GitHub Actions builds and pushes GHCR images (amd64+arm64) and publishes multi-arch manifest tags.
- K8s manifests pass `kubectl apply --dry-run=client -f k8s/` (executor environment must have kubectl).

### Must Have
- No external-network dependency for Playwright verification (FMKorea is never hit in CI).
- Crawl budgets and backoff to prevent retry storms and cost spikes.
- K8s `/dev/shm` and resource settings updated for browser workloads.

### Must NOT Have (guardrails)
- No stealth plugins, fingerprint spoofing kits, or captcha solving.
- No unbounded loops (pages/navigations/retries must be hard-capped).
- No breaking changes to notifier payload formats without explicit docs update.

## Verification Strategy
> ZERO HUMAN INTERVENTION — all verification is agent-executed.
- Tests: keep current `node:test` unit tests + add deterministic Playwright fixture integration.
- Evidence: executor writes logs/artifacts to `.sisyphus/evidence/` per task.

## Execution Strategy
### Parallel Execution Waves
Wave 1 (Foundation): acquisition boundary + budgets + tests harness
Wave 2 (Runtime/Delivery): Docker + CI multi-arch + K8s runtime hardening
Wave 3 (Polish/Docs): scripts/runbooks + final verification wave

### Dependency Matrix (high level)
- W1 tasks unblock W2/W3.
- Docker/CI depends on acquisition + tests harness.
- K8s hardening depends on finalized container strategy.

## TODOs
> Implementation + Test = ONE task. Never separate.

- [ ] 1. Define Playwright-first acquisition contract and refactor `src/monitor.ts`

  **What to do**:
  - Create a dedicated acquisition module boundary:
    - `src/acquire/httpAcquire.ts`: function `acquireHtmlHttp(url, referer, userAgent, timeoutMs)` returning `{ body?: string; status?: number; blocked: boolean; note: string }`.
    - `src/acquire/playwrightAcquire.ts`:
      - `createPlaywrightSession(config)` returns `{ browser, context, close() }`.
      - `acquireHtmlPlaywright(url, userAgent, config, session)` returning `{ body?: string; blocked: boolean; note: string }`.
    - `src/acquire/acquireHtml.ts`: function `acquireHtml(url, referer, userAgent, config)` implementing `CRAWL_MODE` routing.
  - Update `src/monitor.ts` so page acquisition goes through `acquireHtml(...)` only.
  - Ensure Playwright does **not** launch a new browser per URL:
    - Create one Playwright session per poll (per `fetchLatestPosts(...)` call), reuse the context for all candidate URLs, then close it.
  - In `acquireHtmlPlaywright(...)`:
    - Use `chromium.launch({ headless: config.playwrightHeadless, args: ['--no-sandbox','--disable-setuid-sandbox'] })` on Linux.
    - Use `page.goto(url, { waitUntil: 'domcontentloaded', timeout: config.playwrightNavigationTimeoutMs })`.
    - If `config.postSelector` is set, call `page.waitForSelector(config.postSelector, { timeout: config.playwrightNavigationTimeoutMs })` (best-effort; ignore timeout and still capture HTML).
    - Block heavy resources via routing (abort `image|font|media`, keep `script|stylesheet|document`).
    - After navigation, wait `config.playwrightWaitAfterLoadMs` and capture `page.content()`.
  - Ensure the extractor remains unchanged (reuse `extractWithFallback(...)`).
  - Ensure blocked detection is centralized and consistent (status and marker-based).

  **Must NOT do**:
  - Do not change notifier/state interfaces.
  - Do not add stealth plugins.

  **Recommended Agent Profile**:
  - Category: `deep` — Reason: boundary refactor across acquisition + error semantics.
  - Skills: []

  **Parallelization**: Can Parallel: YES | Wave 1 | Blocks: 2,3 | Blocked By: -

  **References**:
  - Current acquisition/extraction: `src/monitor.ts`
  - Entrypoint behavior: `src/index.ts`
  - Config/env parsing: `src/config.ts`

  **Acceptance Criteria**:
  - [ ] `npm run build` exits 0
  - [ ] `npm test` exits 0

  **QA Scenarios**:
  ```
  Scenario: Crawl still runs end-to-end (dry-run)
    Tool: Bash
    Steps: RUN_ONCE=true DRY_RUN=true CRAWL_MODE=http FMKOREA_BOARD_URL=https://m.fmkorea.com/hotdeal npm run start
    Expected: Process exits 0 (or cleanly logs “no matches”) without throwing
    Evidence: .sisyphus/evidence/task-1-http-e2e.txt
  
  Scenario: Blocked acquisition is classified consistently
    Tool: Bash
    Steps: RUN_ONCE=true DRY_RUN=true CRAWL_MODE=auto FMKOREA_BOARD_URL=https://www.fmkorea.com/hotdeal npm run start
    Expected: If blocked, logs show acquisition notes indicating blocked outcome; no infinite retries
    Evidence: .sisyphus/evidence/task-1-block-classification.txt
  ```

  **Commit**: YES | Message: `refactor(acquire): isolate acquisition + mode routing` | Files: `src/acquire/*`, `src/monitor.ts`

- [ ] 2. Make Playwright runtime “budgeted”: hard caps, rate limit, and circuit breaker

  **What to do**:
  - Add env-driven budgets in `src/config.ts` (with safe defaults):
    - `MAX_NAVIGATIONS_PER_POLL` (e.g., default 8)
    - `MAX_WALLTIME_MS_PER_POLL` (e.g., default 30_000)
    - `MAX_RETRIES_PER_URL` (default 1)
    - `MIN_REQUEST_GAP_MS` + jitter
    - `BLOCK_COOLDOWN_MS` (circuit breaker cool-down)
    - `BLOCK_THRESHOLD` (default 3)
  - Implement in `src/monitor.ts`:
    - Stop pagination when budgets hit.
    - If consecutive blocked outcomes exceed threshold, trip breaker and abort poll with a clear log line.

  **Must NOT do**:
  - Do not add concurrency beyond 1 page at a time (keep low to avoid bans/cost spikes).

  **Recommended Agent Profile**:
  - Category: `unspecified-high` — Reason: safety envelope is the core reliability requirement.
  - Skills: []

  **Parallelization**: Can Parallel: YES | Wave 1 | Blocks: 4,5 | Blocked By: 1

  **References**:
  - Poll loop: `src/index.ts`
  - Fetch loop: `src/monitor.ts`
  - Env parsing: `src/config.ts`

  **Acceptance Criteria**:
  - [ ] With budgets set extremely low, the process exits quickly and logs “budget reached” (no hang)

  **QA Scenarios**:
  ```
  Scenario: Budget stops runaway pagination
    Tool: Bash
    Steps: RUN_ONCE=true DRY_RUN=true MAX_PAGES_PER_POLL=50 MAX_NAVIGATIONS_PER_POLL=2 MAX_WALLTIME_MS_PER_POLL=5000 npm run start
    Expected: Crawl stops due to budget; does not attempt 50 pages
    Evidence: .sisyphus/evidence/task-2-budget-stop.txt
  
  Scenario: Circuit breaker triggers on repeated blocks
    Tool: Bash
    Steps: RUN_ONCE=true DRY_RUN=true CRAWL_MODE=playwright FMKOREA_BOARD_URL=https://www.fmkorea.com/hotdeal BLOCK_THRESHOLD=2 npm run start
    Expected: Logs indicate breaker trip and poll abort
    Evidence: .sisyphus/evidence/task-2-breaker.txt
  ```

  **Commit**: YES | Message: `feat(safety): add crawl budgets and breaker` | Files: `src/config.ts`, `src/monitor.ts`

- [ ] 3. Deterministic Playwright verification (offline): fixture server + integration test

  **What to do**:
  - Add `tests/fixtures/hotdeal-list.html` containing a minimal representative list with a few post links and date tokens.
  - Add a node:test integration that:
    - Starts a local HTTP server to serve the fixture.
    - Runs acquisition in `CRAWL_MODE=playwright` against the local URL.
    - Verifies extraction returns expected posts (IDs/links/titles) and publishedAt parsing.
  - Add an npm script `test:pw-fixture` that builds then runs this test.

  **Must NOT do**:
  - Do not hit FMKorea in tests.

  **Recommended Agent Profile**:
  - Category: `quick` — Reason: localized tests + fixtures.
  - Skills: []

  **Parallelization**: Can Parallel: YES | Wave 1 | Blocks: 4 | Blocked By: 1

  **References**:
  - Existing test style: `tests/monitor.test.js`
  - Extraction logic: `src/monitor.ts`

  **Acceptance Criteria**:
  - [ ] `npm run test:pw-fixture` exits 0
  - [ ] `npm test` exits 0

  **QA Scenarios**:
  ```
  Scenario: Playwright renders fixture and extractor finds posts
    Tool: Bash
    Steps: npm run test:pw-fixture
    Expected: Test passes; at least 2 posts extracted; stable IDs present
    Evidence: .sisyphus/evidence/task-3-pw-fixture.txt
  
  Scenario: Blocked HTML fixture is detected
    Tool: Bash
    Steps: Run a second fixture file with anti-bot marker and assert blocked=true
    Expected: Blocked classification is deterministic
    Evidence: .sisyphus/evidence/task-3-block-fixture.txt
  ```

  **Commit**: YES | Message: `test(playwright): add offline fixture integration` | Files: `tests/*`, `package.json`

- [ ] 4. Container strategy: Playwright-ready Dockerfile + runtime smoke

  **What to do**:
  - Replace current `Dockerfile` base strategy with a Playwright-capable, **multi-arch** build:
    - `FROM node:22-bookworm` (Debian-based; required for `--with-deps`).
  - Switch dependency to **`playwright` (pinned to `1.58.2`)** and remove `playwright-core`.
  - During image build, install browser + system deps:
    - `npx -y playwright@1.58.2 install --with-deps chromium`
  - Ensure Docker one-shot runs with enough shared memory:
    - Prefer `docker run --shm-size=512m ...` for Playwright mode.
  - Ensure container runtime uses Chromium-safe args on Linux (`--no-sandbox`, `--disable-dev-shm-usage` only if shm mount is not present).
  - Add a Docker smoke target that runs `npm run test:pw-fixture` inside the image.

  **Must NOT do**:
  - Do not rely on host-installed Chrome in Kubernetes.

  **Recommended Agent Profile**:
  - Category: `unspecified-high` — Reason: Docker multi-stage + Playwright deps.
  - Skills: []

  **Parallelization**: Can Parallel: YES | Wave 2 | Blocks: 5 | Blocked By: 3

  **References**:
  - Current Dockerfile: `Dockerfile`
  - Docker test script: `scripts/run-docker.sh`

  **Acceptance Criteria**:
  - [ ] `docker build -t fmkorea-hotdeal-monitor:test .` exits 0
  - [ ] `docker run --rm fmkorea-hotdeal-monitor:test npm run test:pw-fixture` exits 0

  **QA Scenarios**:
  ```
  Scenario: Docker image includes working Playwright runtime
    Tool: Bash
    Steps: docker build -t fmkorea-hotdeal-monitor:test . && docker run --rm --shm-size=512m fmkorea-hotdeal-monitor:test npm run test:pw-fixture
    Expected: Exit code 0
    Evidence: .sisyphus/evidence/task-4-docker-pw.txt
  ```

  **Commit**: YES | Message: `build(docker): use playwright-capable base image` | Files: `Dockerfile`, `package*.json`, scripts if needed

- [ ] 5. GitHub Actions: multi-arch build/push + deterministic Playwright verification

  **What to do**:
  - Update `.github/workflows/ci.yml`:
    - Add a test job: `npm ci`, `npm run lint`, `npm test`, `npm run test:pw-fixture`.
    - Keep the existing multi-arch buildx build (`linux/amd64,linux/arm64`) since the Dockerfile is multi-arch friendly.
    - Add a container-level verification step:
      - Build the image in CI and run `npm run test:pw-fixture` inside the built image for `linux/amd64` at minimum.

  **Must NOT do**:
  - Do not run FMKorea live E2E in CI.

  **Recommended Agent Profile**:
  - Category: `unspecified-high` — Reason: GH Actions + multi-arch manifests.
  - Skills: []

  **Parallelization**: Can Parallel: YES | Wave 2 | Blocks: 6 | Blocked By: 4

  **References**:
  - Current workflow: `.github/workflows/ci.yml`

  **Acceptance Criteria**:
  - [ ] Workflow runs test job successfully
  - [ ] GHCR has `:latest` manifest with amd64+arm64

  **QA Scenarios**:
  ```
  Scenario: CI validates Playwright path without external network
    Tool: Bash (in CI)
    Steps: Run workflow; inspect logs for test:pw-fixture pass
    Expected: test:pw-fixture step succeeds
    Evidence: .sisyphus/evidence/task-5-ci-logs.txt
  ```

  **Commit**: YES | Message: `ci: add offline playwright test and multi-arch manifest` | Files: `.github/workflows/ci.yml`

- [ ] 6. Kubernetes hardening: /dev/shm, resources, security posture, and env defaults

  **What to do**:
  - Update `k8s/deployment.yaml` and `k8s/deployment-with-file-state.yaml`:
    - Set `CRAWL_MODE=playwright` default.
    - Increase resources to realistic browser baseline (start with requests 500m/512Mi, limits 1 CPU/1Gi).
    - Mount `/dev/shm` via `emptyDir` memory volume (set `medium: Memory`, start with `sizeLimit: 512Mi`).
    - Add `securityContext`:
      - `runAsNonRoot: true`
      - `allowPrivilegeEscalation: false`
      - `readOnlyRootFilesystem: false` (default for compatibility; if enabling true, mount writable `emptyDir` for `/tmp` and any state path)
      - `seccompProfile: RuntimeDefault`
      - drop all capabilities
    - Document sandbox posture:
      - Default to `--no-sandbox` on linux unless cluster explicitly supports sandbox (explicit note).
  - Update `k8s/configmap.yaml`:
    - Mobile-first board URL (`https://m.fmkorea.com/hotdeal`) and desktop fallback.
    - Playwright envs as needed (headless, timeouts).
    - Set sane defaults:
      - `PLAYWRIGHT_HEADLESS=true`
      - `PLAYWRIGHT_NAV_TIMEOUT_MS=20000`
      - `PLAYWRIGHT_WAIT_AFTER_LOAD_MS=900`

  **Must NOT do**:
  - Do not require PV volume unless user chooses file-state mode.

  **Recommended Agent Profile**:
  - Category: `unspecified-high` — Reason: K8s security + runtime stability.
  - Skills: []

  **Parallelization**: Can Parallel: YES | Wave 2 | Blocks: 7 | Blocked By: 4

  **References**:
  - `k8s/deployment.yaml`
  - `k8s/deployment-with-file-state.yaml`
  - `k8s/configmap.yaml`

  **Acceptance Criteria**:
  - [ ] `kubectl apply --dry-run=client -f k8s/` exits 0

  **QA Scenarios**:
  ```
  Scenario: Manifests validate client-side
    Tool: Bash
    Steps: kubectl apply --dry-run=client -f k8s/
    Expected: Exit code 0
    Evidence: .sisyphus/evidence/task-6-k8s-dryrun.txt
  ```

  **Commit**: YES | Message: `k8s: harden playwright runtime (shm/resources/security)` | Files: `k8s/*.yaml`

- [ ] 7. Scripts + docs: one-shot runbooks for Docker/K8s + troubleshooting

  **What to do**:
  - Update scripts to expose Playwright mode clearly:
    - `scripts/run-docker.sh`: add explicit path to run `npm run test:pw-fixture` inside container as an option.
    - `scripts/run-local.sh` and `scripts/run-samdau-batch.sh`: document `CRAWL_MODE` usage and mobile-first URL.
  - Update `.env.example` defaults for Playwright-first operation.
  - Update `README.md` with:
    - When to use `http` vs `auto` vs `playwright`
    - Container/K8s resource expectations
    - Common failure modes: blocked responses, shm issues, sandbox restrictions

  **Recommended Agent Profile**:
  - Category: `writing` — Reason: runbooks and troubleshooting.
  - Skills: []

  **Parallelization**: Can Parallel: YES | Wave 3 | Blocks: - | Blocked By: 4,6

  **Acceptance Criteria**:
  - [ ] Fresh clone can run `./scripts/run-samdau-batch.sh` and see a clear summary without configuration

  **QA Scenarios**:
  ```
  Scenario: One-shot docker run command is documented and works
    Tool: Bash
    Steps: Follow README command to run docker one-shot
    Expected: Container exits cleanly and prints summary lines
    Evidence: .sisyphus/evidence/task-7-docker-one-shot.txt
  ```

  **Commit**: YES | Message: `docs: playwright-first runbooks and env defaults` | Files: `README.md`, `.env.example`, `scripts/*`

## Final Verification Wave (4 parallel agents, ALL must APPROVE)
- [ ] F1. Plan Compliance Audit — oracle
- [ ] F2. Code Quality Review — unspecified-high
- [ ] F3. Real QA (local + docker one-shot) — unspecified-high
- [ ] F4. Scope Fidelity Check — deep

## Commit Strategy
- Prefer 5–7 atomic commits matching the task boundaries above.
- No commit includes secrets; `.env` is never committed.

## Success Criteria
- Playwright-first crawling runs in Docker and Kubernetes without shm-related crashes.
- CI verifies Playwright path deterministically without hitting FMKorea.
- Crawl behavior remains bounded under blocking (no runaway retries/navigations).
