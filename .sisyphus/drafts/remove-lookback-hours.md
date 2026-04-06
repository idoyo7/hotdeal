# Draft: Remove Lookback Hours

## Requirements (confirmed)
- remove the `lookbackHours` concept entirely from runtime behavior, config, logs, docs, and scripts
- keep fixed runtime behavior: startup scans 5 pages, recurring scans 1 page
- do not keep page-depth or lookback behavior as user-facing knobs
- preserve `RUN_ONCE=true` as startup-profile-only execution
- candidate eligibility must not depend on `publishedAt`; missing or invalid dates must not block candidacy

## Technical Decisions
- use fixed internal runtime profiles instead of env-driven lookback semantics
- keep `publishedAt` as metadata/logging only, not as a filtering gate
- retain `maxItemsPerPoll` as an enforced final cap even after page-depth refactor
- remove stale startup config fields from `MonitoringConfig` so types match actual runtime contract
- replace stale README script references with tracked, direct Kubernetes usage or remove those sections entirely

## Research Findings
- `src/config.ts:28-31` still declares stale startup paging/item fields even though runtime now uses fixed profile constants
- `src/monitor.ts:777` currently returns filtered results without `.slice(0, config.maxItemsPerPoll)`, leaving the item cap unenforced
- `README.md:131` still references `scripts/apply-k8s-from-config.sh`, which is not present in the tracked worktree
- `README.md:210` still references `scripts/sambdasu-batch.sh` and wrapper scripts that are not present in the tracked worktree
- the existing plan in `.sisyphus/plans/remove-lookback-hours.md` already captures the target behavior and verification expectations

## Open Questions
- none currently blocking; remaining issues are implementation and verification gaps, not product ambiguities

## Scope Boundaries
- INCLUDE: runtime profile cleanup, config type cleanup, item-cap enforcement, test coverage for `RUN_ONCE` and date-agnostic candidacy, README cleanup, verification rerun
- EXCLUDE: notifier delivery changes, Redis semantics changes, leader election changes, crawl-mode changes, anti-bot changes
