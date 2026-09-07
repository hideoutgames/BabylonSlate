# GitHub Actions — PR cadence

Verify uses standard runners: `static` + `unit` + seven `e2e` shards = 9 jobs per ready PR. At most two counted ready PRs use 18 jobs; after one merges, the remaining PR + `main` Verify + Preview use 19. Keep this below GitHub Free's 20-job cap. Draft PRs record skipped checks but do not run these jobs.

## Local verification before opening

- Pass full local `pnpm verify` before opening any PR, including a draft. A failed or unavailable run is not sufficient.
- Open the verified work as a draft, then check for a Verify slot. Do not use draft PRs as a substitute for local testing.

## Wait for a slot, then mark ready once

- Count open non-draft PRs targeting `main` with `gh pr list --base main --state open --json number,isDraft` or equivalent. Exclude this PR and [#271](https://github.com/hideoutgames/BabylonSlate/pull/271). Do not count `main`'s own Verify.
- If two other counted PRs are ready, leave this PR draft and recheck periodically (for example, every 60 seconds). Keep the user informed and continue when a slot opens. Do not end the task solely because the slots are occupied, change other agents' PRs, or exceed the cap.
- Recheck immediately before marking ready. Mark ready once; do not toggle draft status to restart CI.
- The slot limit governs admission to CI. An already-ready PR may receive verified fixes and merge when its gates pass; it does not need a second free slot.

## Monitor, repair, and merge

Follow [the delivery workflow](agent-workflow.md#workflow) through CI completion and confirmed merge. Batch repairs, pass local `pnpm verify`, then push; each ready-PR push restarts nine Verify jobs. Pending CI is a reason to wait, not to hand the task back. Missing or skipped checks are not proof of a passing Verify run.

Do not use larger runners to raise the cap. See [standard runners](github-actions-standard-runners.md).
