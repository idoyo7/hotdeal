# Remove Lookback Hours

## TL;DR
> **Summary**: Remove hour-based candidate eligibility and public lookback-related knobs. Keep a fixed two-mode runtime: startup scans 5 pages, recurring cycles scan 1 page.
> **Deliverables**:
> - runtime logic rewritten around page-depth-only candidate selection
> - public config/scripts/docs/logs/tests updated to remove lookback semantics
> - startup vs recurring behavior preserved with fixed internal defaults
> **Effort**: Medium
> **Parallel**: YES - 2 waves
> **Critical Path**: T1 -> T2 -> T3/T4/T5 -> T6/T7/T8 -> T9

## Context
### Original Request
- Remove the `lookbackHours` concept entirely.
- Keep startup behavior as a wider scan and recurring behavior as a shallow scan.
- Use startup = 5 pages, recurring = 1 page.
- Do not keep this as changeable logging/config options.
- Refactor the whole repo surface accordingly.

### Interview Summary
- Startup page depth is fixed at 5 pages.
- Recurring page depth is fixed at 1 page.
- Tests-after is required.
- Page/item/runtime behavior should stop being user-facing knobs.
- Date-based eligibility should be removed; fetched posts within the active page depth are candidate-eligible even if `publishedAt` is missing or unparsable.
- Batch/reporting scripts are in scope for terminology and behavior cleanup.

### Metis Review (gaps addressed)
- Guard against half-removal: update `.env.example`, `README.md`, `docs/runtime-behavior.md`, scripts, k8s config, and tests together.
- Treat this as a semantic change, not cosmetic renaming.
- Preserve `firstRun` / `RUN_ONCE` behavior while removing hour-based branching.
- Remove stale runtime/log tokens such as `lookbackHours`, `startupLookbackHours`, `showRecentHours`, `OUT_OF_WINDOW`, and `options.lookbackHours`.
- Fix existing repo drift where startup depth is documented inconsistently.

## Work Objectives
### Core Objective
- Refactor the FMKorea monitor so candidate eligibility depends only on fetched page depth, with a fixed startup scan depth of 5 pages and a fixed recurring scan depth of 1 page.

### Deliverables
- Runtime code no longer parses or applies lookback-hour config for candidate selection.
- Startup/steady-state behavior remains split, but only through fixed internal page/item defaults.
- User-facing config, logs, docs, and helper scripts no longer describe hour-based eligibility.
- Tests cover startup depth, recurring depth, `RUN_ONCE`, and non-date-based candidate eligibility.

### Definition of Done (verifiable conditions with commands)
- `npm run build` exits `0`.
- `npm test` exits `0`.
- Repo audit over in-scope files returns zero matches for removed semantics: `LOOKBACK_HOURS`, `STARTUP_LOOKBACK_HOURS`, `showRecentHours`, `startupLookbackHours`, `lookbackHours`, `OUT_OF_WINDOW`, `out_of_window`.
- Runtime logs for a cycle expose startup/recurring page depth without hour-based fields.

### Must Have
- Fixed runtime behavior: startup = 5 pages, recurring = 1 page.
- `RUN_ONCE=true` executes only the startup profile and exits.
- `firstRun` split is preserved.
- Missing or unparsable `publishedAt` does not block candidate eligibility.
- Batch/reporting scripts, README, docs, `.env.example`, tests, and k8s config are updated in the same change.

### Must NOT Have
- No new runtime/env knobs for hour-based or page-depth-based behavior.
- No leftover user-facing `lookback` fields in logs, config tables, docs, or examples.
- No changes to notifier delivery, Redis/file-state semantics, leader election, crawl-mode selection, or anti-bot logic.
- No silent behavioral split where code changes but docs/scripts still advertise old semantics.

## Verification Strategy
> ZERO HUMAN INTERVENTION - all verification is agent-executed.
- Test decision: tests-after with existing Node test suite + build validation.
- QA policy: Every task includes code + verification together.
- Evidence: `.sisyphus/evidence/task-{N}-{slug}.{ext}`

## Execution Strategy
### Parallel Execution Waves
> Target: 5-8 tasks per wave. Shared runtime decisions happen first; repo-surface cleanup follows.

Wave 1: runtime simplification (`src/index.ts`, `src/config.ts`, `src/monitor.ts`, tests)
Wave 2: repo-surface cleanup (`k8s/configmap.yaml`, `.env.example`, `README.md`, `docs/runtime-behavior.md`, scripts, logger tests)

### Dependency Matrix (full, all tasks)
| Task | Depends On | Notes |
|---|---|---|
| T1 | - | Freeze fixed runtime constants and removed surfaces |
| T2 | T1 | Remove config/env plumbing for lookback semantics |
| T3 | T1 | Rewrite candidate selection to ignore publication time |
| T4 | T2,T3 | Rewrite cycle/report logging around page-depth semantics |
| T5 | T2,T3 | Replace runtime tests for startup/recurring/page-only eligibility |
| T6 | T2,T4 | Update k8s + `.env.example` + local/docker run scripts |
| T7 | T2,T4 | Update batch/reporting scripts wording/behavior |
| T8 | T2,T4 | Update README + runtime docs |
| T9 | T5,T6,T7,T8 | Run audits/build/tests and close drift |

### Agent Dispatch Summary
| Wave | Task Count | Categories |
|---|---:|---|
| 1 | 5 | `unspecified-high`, `quick` |
| 2 | 4 | `writing`, `quick`, `unspecified-high` |
| Final | 4 | `oracle`, `unspecified-high`, `deep` |

## TODOs
> Implementation + Test = ONE task. Never separate.
> EVERY task MUST have: Agent Profile + Parallelization + QA Scenarios.

- [ ] 1. Freeze fixed runtime semantics and in-scope surfaces

  **What to do**: Define the canonical behavior in code comments/plan context for the implementer before touching logic: startup cycle uses fixed depth `5` pages, recurring cycle uses fixed depth `1` page, hour-based eligibility is removed, `publishedAt` no longer gates candidates, and page/item knobs stop being user-facing. Use this decision to identify all runtime-facing and documentation-facing surfaces to be changed in a single pass.
  **Must NOT do**: Do not alter notifier, Redis, leader election, or scraping selector behavior.

  **Recommended Agent Profile**:
  - Category: `unspecified-high` — Reason: central refactor framing across runtime/config/docs/tests.
  - Skills: `[]` — no special skill required.
  - Omitted: [`git-master`] — no git work needed.

  **Parallelization**: Can Parallel: NO | Wave 1 | Blocks: 2,3,4,5,6,7,8,9 | Blocked By: none

  **References**:
  - Pattern: `src/index.ts:714` — current startup vs recurring split anchored on `firstRun`.
  - Pattern: `src/config.ts:165` — current public paging/item config surface.
  - Pattern: `src/config.ts:185` — current public lookback config surface to remove.
  - Doc: `docs/runtime-behavior.md:8` — current user-facing runtime model that must be rewritten.

  **Acceptance Criteria**:
  - [ ] Implementer can point to one canonical runtime model: startup `5` pages, recurring `1` page, no hour-based eligibility.
  - [ ] No task later in the plan depends on unresolved semantic choices.

  **QA Scenarios**:
  ```text
  Scenario: Scope freeze audit
    Tool: Bash
    Steps: Run a repo grep for lookback/page knobs before edits to capture affected surfaces.
    Expected: A finite in-scope file list is identified and used by later tasks.
    Evidence: .sisyphus/evidence/task-1-scope-audit.txt

  Scenario: Scope creep guard
    Tool: Bash
    Steps: Diff touched files after implementation.
    Expected: No unrelated delivery, leader election, or state-store files are changed.
    Evidence: .sisyphus/evidence/task-1-scope-guard.txt
  ```

  **Commit**: NO | Message: `n/a` | Files: `src/index.ts`, `src/config.ts`, `README.md`, `docs/runtime-behavior.md`, `k8s/configmap.yaml`, `.env.example`, `scripts/*.sh`, `tests/*.js`

- [ ] 2. Remove lookback/env plumbing from runtime configuration

  **What to do**: Refactor `src/config.ts` so runtime configuration no longer exposes `lookbackHours`, `startupLookbackHours`, or `showRecentHours`. Replace public paging knobs with fixed internal defaults for startup/recurring depth and any required item caps. Update `.env.example` and `k8s/configmap.yaml` so removed variables disappear from user-facing config, while fixed runtime values remain represented only where unavoidable for deployment wiring.
  **Must NOT do**: Do not leave deprecated lookback variables half-wired or silently read without a deliberate documented decision.

  **Recommended Agent Profile**:
  - Category: `unspecified-high` — Reason: runtime config contract change with downstream impact.
  - Skills: `[]` — no special skill required.
  - Omitted: [`playwright`] — no browser work.

  **Parallelization**: Can Parallel: NO | Wave 1 | Blocks: 4,5,6,7,8,9 | Blocked By: 1

  **References**:
  - API/Type: `src/config.ts:24` — current config type fields for paging/startup knobs.
  - API/Type: `src/config.ts:185` — lookback env parsing to remove.
  - Pattern: `k8s/configmap.yaml:12` — current runtime deployment defaults.
  - Pattern: `.env.example` — current public example env surface called out by Metis.

  **Acceptance Criteria**:
  - [ ] `src/config.ts` no longer returns `lookbackHours`, `startupLookbackHours`, or `showRecentHours`.
  - [ ] In-scope env/config files no longer advertise `LOOKBACK_HOURS` or `STARTUP_LOOKBACK_HOURS`.
  - [ ] Fixed startup/recurring paging behavior is represented consistently across code and deployment defaults.

  **QA Scenarios**:
  ```text
  Scenario: Removed knob audit
    Tool: Bash
    Steps: Run grep across `src`, `k8s`, `.env.example`, `README.md`, `docs`, `scripts`, `tests` for `LOOKBACK_HOURS|STARTUP_LOOKBACK_HOURS|showRecentHours|startupLookbackHours|lookbackHours`.
    Expected: No matches remain in agreed in-scope files.
    Evidence: .sisyphus/evidence/task-2-knob-audit.txt

  Scenario: Config compile check
    Tool: Bash
    Steps: Run `npm run build` after config refactor.
    Expected: Build exits `0` with no config type errors.
    Evidence: .sisyphus/evidence/task-2-build.txt
  ```

  **Commit**: NO | Message: `n/a` | Files: `src/config.ts`, `k8s/configmap.yaml`, `.env.example`

- [ ] 3. Rewrite candidate selection to page-depth-only eligibility

  **What to do**: Refactor `pollOnce` and any helper usage so candidate selection no longer depends on `findRecentMatchedPosts(..., hours, ...)` or publication-time cutoffs. Candidate eligibility should become: fetched within active page depth, title matches keyword (or no keyword filter), and not already claimed/processed. Preserve `publishedAt` extraction as metadata only. Remove `outOfWindow` accounting and any logic that rejects missing/unparseable dates.
  **Must NOT do**: Do not stop extracting `publishedAt`; keep it available for informational logging if still useful.

  **Recommended Agent Profile**:
  - Category: `unspecified-high` — Reason: core behavior change in polling logic.
  - Skills: `[]` — no special skill required.
  - Omitted: [`writing`] — code logic task.

  **Parallelization**: Can Parallel: NO | Wave 1 | Blocks: 4,5,9 | Blocked By: 1,2

  **References**:
  - Pattern: `src/index.ts:272` — current `pollOnce` pipeline from fetch to candidate selection.
  - Pattern: `src/index.ts:278` — current effective lookback calculation to remove.
  - Pattern: `src/index.ts:292` — current out-of-window/unparseable accounting.
  - API/Type: `src/monitor.ts:764` — `findRecentMatchedPosts` current date-window helper.

  **Acceptance Criteria**:
  - [ ] `pollOnce` no longer computes cutoff times or rejects posts based on `publishedAt`.
  - [ ] Missing or bad `publishedAt` does not prevent a fetched keyword-matching post from becoming a candidate.
  - [ ] Startup/recurring behavior still differs by page depth only.

  **QA Scenarios**:
  ```text
  Scenario: Candidate eligibility without dates
    Tool: Bash
    Steps: Run `npm test` with updated monitor tests covering missing and invalid `publishedAt` in fetched posts.
    Expected: Tests prove keyword-matching fetched posts remain eligible without date gating.
    Evidence: .sisyphus/evidence/task-3-tests.txt

  Scenario: Runtime branch audit
    Tool: Bash
    Steps: Grep `src/index.ts` for `cutoff`, `outOfWindow`, and `findRecentMatchedPosts(` usage after refactor.
    Expected: No candidate-selection path still depends on hour-based filtering.
    Evidence: .sisyphus/evidence/task-3-audit.txt
  ```

  **Commit**: NO | Message: `n/a` | Files: `src/index.ts`, `src/monitor.ts`

- [ ] 4. Rewrite runtime logging around page-depth semantics only

  **What to do**: Update structured logs in `src/index.ts` and any affected logger tests so cycle summaries, pipeline summaries, and recent-match diagnostics no longer emit `lookbackHours`, `outOfWindow`, or hour-window wording. Replace them with startup/recurring depth terminology and fetched/matched/candidate/skipped/unparseable counts only where still meaningful.
  **Must NOT do**: Do not reintroduce duplicate info/debug mirror events or user-facing log toggles for removed semantics.

  **Recommended Agent Profile**:
  - Category: `quick` — Reason: localized runtime/log payload cleanup after core logic settles.
  - Skills: `[]` — no special skill required.
  - Omitted: [`writing`] — primarily code/log schema alignment.

  **Parallelization**: Can Parallel: YES | Wave 1 | Blocks: 8,9 | Blocked By: 2,3

  **References**:
  - Pattern: `src/index.ts:71` — current recent-match reporting built around time windows.
  - Pattern: `src/index.ts:334` — current pipeline summary fields including `lookbackHours` and `outOfWindow`.
  - Pattern: `src/index.ts:736` — current cycle completion payload includes `options.lookbackHours`.
  - Test: `tests/logger.test.js:38` — current structured log expectation that mentions `lookbackHours`.

  **Acceptance Criteria**:
  - [ ] No runtime log payload includes `lookbackHours`.
  - [ ] No runtime event names or classifications reference `OUT_OF_WINDOW` / hour windows.
  - [ ] Cycle logs still expose enough context to distinguish startup (5 pages) vs recurring (1 page).

  **QA Scenarios**:
  ```text
  Scenario: Log schema audit
    Tool: Bash
    Steps: Grep `src` and `tests` for `lookbackHours|OUT_OF_WINDOW|outOfWindow` after log refactor.
    Expected: No runtime-facing log schema or assertions use removed fields.
    Evidence: .sisyphus/evidence/task-4-log-audit.txt

  Scenario: Structured logger verification
    Tool: Bash
    Steps: Run `npm test` and inspect the logger test output.
    Expected: Structured logger tests pass with page-depth-oriented payloads.
    Evidence: .sisyphus/evidence/task-4-logger-tests.txt
  ```

  **Commit**: NO | Message: `n/a` | Files: `src/index.ts`, `tests/logger.test.js`

- [ ] 5. Replace hour-based tests with startup/recurring page-depth coverage

  **What to do**: Rewrite `tests/monitor.test.js` so the suite validates the new runtime semantics: startup cycle uses 5-page depth, recurring cycle uses 1-page depth, `RUN_ONCE=true` executes only the startup profile, and candidate eligibility is not date-gated. Remove assertions that depend on hour-window filtering or `findRecentMatchedPosts` semantics if that helper is removed or repurposed.
  **Must NOT do**: Do not leave stale test names or fixtures describing recent-hour behavior.

  **Recommended Agent Profile**:
  - Category: `unspecified-high` — Reason: behavior regression protection for a semantic refactor.
  - Skills: `[]` — no special skill required.
  - Omitted: [`playwright`] — unit/integration tests only.

  **Parallelization**: Can Parallel: YES | Wave 1 | Blocks: 9 | Blocked By: 2,3

  **References**:
  - Test: `tests/monitor.test.js:31` — existing hour-based candidate tests to replace.
  - Pattern: `src/index.ts:700` — `firstRun` loop semantics that tests must cover.
  - Pattern: `src/index.ts:760` — `RUN_ONCE` exit point to preserve.
  - Pattern: `src/monitor.ts:58` — existing extraction regression test style for focused monitor behavior.

  **Acceptance Criteria**:
  - [ ] Test suite covers startup page depth `5` and recurring page depth `1`.
  - [ ] Test suite covers `RUN_ONCE=true` as startup-profile-only behavior.
  - [ ] No remaining monitor tests assert hour-window eligibility behavior.

  **QA Scenarios**:
  ```text
  Scenario: Unit test replacement
    Tool: Bash
    Steps: Run `npm test` after rewriting monitor tests.
    Expected: Tests pass and include explicit assertions for startup vs recurring depth and no date gating.
    Evidence: .sisyphus/evidence/task-5-monitor-tests.txt

  Scenario: Stale test wording audit
    Tool: Bash
    Steps: Grep `tests` for `lookback|recent|OUT_OF_WINDOW` after test updates.
    Expected: No removed semantics remain in test names or assertions.
    Evidence: .sisyphus/evidence/task-5-stale-test-audit.txt
  ```

  **Commit**: NO | Message: `n/a` | Files: `tests/monitor.test.js`, `tests/logger.test.js`

- [ ] 6. Simplify deployment and example configuration surfaces

  **What to do**: Update `k8s/configmap.yaml`, `.env.example`, and one-shot/local runner scripts so deployment examples no longer expose lookback-hour knobs. Keep only the simplified runtime description and any still-needed immutable defaults. Ensure Kubernetes reflects startup `5` pages and recurring `1` page consistently.
  **Must NOT do**: Do not leave misleading env examples that imply operators can tune removed semantics.

  **Recommended Agent Profile**:
  - Category: `quick` — Reason: bounded config/example cleanup.
  - Skills: `[]` — no special skill required.
  - Omitted: [`git-master`] — no git work.

  **Parallelization**: Can Parallel: YES | Wave 2 | Blocks: 9 | Blocked By: 2,4

  **References**:
  - Pattern: `k8s/configmap.yaml:12` — runtime deployment values to keep aligned.
  - Pattern: `.env.example` — old user-facing startup/lookback knobs called out by Metis.
  - Script: `scripts/run-local.sh:12` — current one-shot local defaults with `LOOKBACK_HOURS`.
  - Script: `scripts/run-docker.sh:22` — current container example wiring.

  **Acceptance Criteria**:
  - [ ] In-scope deployment/example config files no longer expose lookback-hour vars.
  - [ ] Startup/recurring page-depth defaults are consistent across k8s and local examples.
  - [ ] `bash scripts/apply-k8s-from-config.sh --dry-run` succeeds after config cleanup.

  **QA Scenarios**:
  ```text
  Scenario: K8s config validation
    Tool: Bash
    Steps: Run `bash scripts/apply-k8s-from-config.sh --dry-run`.
    Expected: Dry-run validation succeeds with updated ConfigMap and secret generation.
    Evidence: .sisyphus/evidence/task-6-k8s-dry-run.txt

  Scenario: Example surface audit
    Tool: Bash
    Steps: Grep `.env.example`, `k8s`, and local/docker scripts for removed lookback tokens.
    Expected: No removed user-facing knobs remain.
    Evidence: .sisyphus/evidence/task-6-example-audit.txt
  ```

  **Commit**: NO | Message: `n/a` | Files: `k8s/configmap.yaml`, `.env.example`, `scripts/run-local.sh`, `scripts/run-docker.sh`, `scripts/run-keyword-once-local.sh`, `scripts/run-keyword-once-docker.sh`

- [ ] 7. Rewrite batch/reporting scripts to page-depth semantics

  **What to do**: Update batch/reporting scripts that currently speak in recent-hour terms so they align with the simplified runtime model. Remove hour-based environment exports and wording, replace them with startup/scan-depth language or fixed behavior descriptions, and keep the scripts operational without reintroducing user-tunable hour semantics.
  **Must NOT do**: Do not silently exclude scripts that still guide operators or emit stale “recent N hours” messages.

  **Recommended Agent Profile**:
  - Category: `unspecified-high` — Reason: multiple script surfaces with behavioral/log wording drift.
  - Skills: `[]` — no special skill required.
  - Omitted: [`writing`] — mixed shell + wording cleanup.

  **Parallelization**: Can Parallel: YES | Wave 2 | Blocks: 9 | Blocked By: 2,4

  **References**:
  - Script: `scripts/run-sambdasu-batch.sh:151` — current lookback export and operator messaging.
  - Script: `scripts/run-jejusamdau-batch.sh:17` — current single-run lookback wiring.
  - Script: `scripts/run-nivea-batch.sh:17` — current hour-based wording and page output.
  - Pattern: `scripts/*.sh` — repo-wide shell surfaces found by grep.

  **Acceptance Criteria**:
  - [ ] In-scope batch/reporting scripts no longer export or describe `LOOKBACK_HOURS`.
  - [ ] Script output messages use scan-depth/runtime wording, not recent-hour wording.
  - [ ] Shell syntax remains valid for all modified scripts.

  **QA Scenarios**:
  ```text
  Scenario: Script syntax validation
    Tool: Bash
    Steps: Run `bash -n` over every modified script.
    Expected: All modified shell scripts pass syntax checks.
    Evidence: .sisyphus/evidence/task-7-shellcheck.txt

  Scenario: Script wording audit
    Tool: Bash
    Steps: Grep modified scripts for `lookback|최근 .*시간|LOOKBACK_HOURS`.
    Expected: No stale hour-based messaging remains.
    Evidence: .sisyphus/evidence/task-7-wording-audit.txt
  ```

  **Commit**: NO | Message: `n/a` | Files: `scripts/run-sambdasu-batch.sh`, `scripts/run-jejusamdau-batch.sh`, `scripts/run-nivea-batch.sh`

- [ ] 8. Rewrite public documentation for page-depth-only behavior

  **What to do**: Update `README.md` and `docs/runtime-behavior.md` so they describe the new mental model precisely: startup scans 5 pages, recurring scans 1 page, alerts are based on fetched-page candidates rather than time windows, and `RUN_ONCE` executes only the startup profile. Remove all hour-based config tables, examples, and operational explanations.
  **Must NOT do**: Do not leave mixed terminology where some docs still mention recent-hour windows.

  **Recommended Agent Profile**:
  - Category: `writing` — Reason: multi-file docs rewrite with technical accuracy constraints.
  - Skills: `[]` — no special skill required.
  - Omitted: [`frontend-ui-ux`] — not relevant.

  **Parallelization**: Can Parallel: YES | Wave 2 | Blocks: 9 | Blocked By: 2,4

  **References**:
  - Doc: `README.md:115` — current config table still documents `LOOKBACK_HOURS` / `STARTUP_LOOKBACK_HOURS`.
  - Doc: `README.md:210` — current usage example teaches hour-based operation.
  - Doc: `docs/runtime-behavior.md:9` — current startup vs recurring section still hour-based and drifted.
  - Pattern: `src/index.ts:700` — runtime behavior that docs must now explain accurately.

  **Acceptance Criteria**:
  - [ ] Public docs no longer mention lookback-hour semantics.
  - [ ] Docs explicitly explain startup `5` pages, recurring `1` page, and `RUN_ONCE` startup-only behavior.
  - [ ] Docs align with `k8s/configmap.yaml` and actual runtime logic.

  **QA Scenarios**:
  ```text
  Scenario: Documentation drift audit
    Tool: Bash
    Steps: Grep `README.md` and `docs/runtime-behavior.md` for `LOOKBACK_HOURS|STARTUP_LOOKBACK_HOURS|lookback|최근 .*시간`.
    Expected: No stale hour-based guidance remains.
    Evidence: .sisyphus/evidence/task-8-doc-audit.txt

  Scenario: Runtime-doc consistency check
    Tool: Bash
    Steps: Compare documented startup/recurring values against `k8s/configmap.yaml` and runtime constants using grep/read.
    Expected: No startup depth drift remains.
    Evidence: .sisyphus/evidence/task-8-consistency.txt
  ```

  **Commit**: NO | Message: `n/a` | Files: `README.md`, `docs/runtime-behavior.md`

- [ ] 9. Run final repo audit and verification pass

  **What to do**: Execute the final validation sweep across code, tests, configs, docs, and scripts. Run build/tests, validate k8s dry-run, syntax-check modified shell scripts, and perform the repo-wide removed-token audit over the agreed in-scope files. Fix any remaining minor drift silently before closing.
  **Must NOT do**: Do not declare completion while any stale lookback token or inconsistent startup depth remains in-scope.

  **Recommended Agent Profile**:
  - Category: `unspecified-high` — Reason: broad final verification across multiple surfaces.
  - Skills: `[]` — no special skill required.
  - Omitted: [`playwright`] — no browser verification required for this refactor.

  **Parallelization**: Can Parallel: NO | Wave 2 | Blocks: Final Verification Wave | Blocked By: 3,4,5,6,7,8

  **References**:
  - Pattern: `src/index.ts`, `src/config.ts`, `src/monitor.ts` — runtime surfaces requiring zero stale semantics.
  - Pattern: `k8s/configmap.yaml`, `.env.example`, `README.md`, `docs/runtime-behavior.md`, `scripts/*.sh`, `tests/*.js` — full in-scope repo audit surface.
  - Command: `bash scripts/apply-k8s-from-config.sh --dry-run` — deployment validation path already used in repo.

  **Acceptance Criteria**:
  - [ ] `npm run build` exits `0`.
  - [ ] `npm test` exits `0`.
  - [ ] `bash scripts/apply-k8s-from-config.sh --dry-run` exits `0`.
  - [ ] `bash -n` passes for all modified shell scripts.
  - [ ] Repo audit returns zero matches for `LOOKBACK_HOURS|STARTUP_LOOKBACK_HOURS|showRecentHours|startupLookbackHours|lookbackHours|OUT_OF_WINDOW|out_of_window` in the agreed in-scope files.

  **QA Scenarios**:
  ```text
  Scenario: Final build and test sweep
    Tool: Bash
    Steps: Run `npm run build && npm test && bash scripts/apply-k8s-from-config.sh --dry-run`.
    Expected: All commands exit `0`.
    Evidence: .sisyphus/evidence/task-9-verification.txt

  Scenario: Final stale-token audit
    Tool: Bash
    Steps: Run repo grep across `src`, `tests`, `scripts`, `k8s`, `.env.example`, `README.md`, `docs` for removed lookback tokens.
    Expected: Zero matches in agreed in-scope files.
    Evidence: .sisyphus/evidence/task-9-token-audit.txt
  ```

  **Commit**: YES | Message: `refactor(runtime): remove lookback-hour candidate filtering` | Files: `src/index.ts`, `src/config.ts`, `src/monitor.ts`, `k8s/configmap.yaml`, `.env.example`, `README.md`, `docs/runtime-behavior.md`, `scripts/*.sh`, `tests/*.js`

## Final Verification Wave (4 parallel agents, ALL must APPROVE)
- [ ] F1. Plan Compliance Audit - oracle
- [ ] F2. Code Quality Review - unspecified-high
- [ ] F3. Real Manual QA - unspecified-high
- [ ] F4. Scope Fidelity Check - deep

## Commit Strategy
- Single refactor commit after runtime, repo-surface cleanup, and tests all pass.
- Suggested message: `refactor(runtime): remove lookback-hour candidate filtering`

## Success Criteria
- The monitor no longer uses time windows to decide candidate eligibility.
- Startup scans exactly 5 pages; recurring scans exactly 1 page.
- Public docs/config/examples no longer teach lookback-hour behavior.
- Tests prove startup/recurring depth and `RUN_ONCE` behavior.
