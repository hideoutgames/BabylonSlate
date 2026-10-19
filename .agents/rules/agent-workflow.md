# Agent workflow rules

## Verification

- Run only targeted local checks: explicit test files or cases that protect the changed behaviour, directly affected consumers when there is a concrete regression risk, and scoped lint and typechecks. Pass that set before opening or updating a PR, drafts included.
- Do not run unfiltered `pnpm test`, `test:editor-unit`, coverage, all browser tests, `pnpm verify`, `pnpm verify:local` or workspace-wide typechecks unless the user explicitly asks. A PR request, a failing CI job, or a lockfile, infrastructure or exported-API change does not count as asking; reproduce the specific failure or check the affected consumers instead.
- Check what a command actually runs before using it: a "preflight" or related-test runner can expand to broad checks. Never alter CI or weaken assertions to reduce local work.
- Prose-only and instruction-only edits need a diff and link review, not application tests or a docs rebuild.
- After a repair, rerun only the checks the repair affects. Keep earlier results for unchanged behaviour, record each command, scope, result and revision, and say why a reused result still applies. Failed, skipped or pending results never count as passing.
- Required GitHub CI owns exhaustive tests, coverage, workspace checks and browser suites; local success does not certify them.
- Fix local failures before opening a PR. If verification cannot run, repair the setup where possible; otherwise report the blocker and open no PR.
- Wait for local tests, CI and Verify slots with the [wait-efficiently](../skills/wait-efficiently/SKILL.md) helper.
- Keep `BL_TEST_PROFILE=shared`: one root workload and one worker, at least 2 GiB host headroom, no smaller-job bypass; `CI=true` never changes local admission. Inspect `pnpm test:resources` before a reproduction and follow [local execution settings](../reference/testing.md#local-test-execution). Do not override reservations or bypass source and configuration validation.

## Testing

- Every test protects an observable behaviour, public contract, important invariant or plausible regression; make sure the assertion would catch the break.
- For a bug fix, add a regression test only where existing tests leave a genuine behaviour gap; when you add one, confirm it fails before the fix. New behaviour covers the expected outcome and its relevant boundary or failure cases.
- Extend an existing test when it fits; add a test only for a distinct requirement or failure mode. No tests that mirror implementation, test constants or the framework, confirm mock setup, or exist to raise counts or coverage.
- Test through the smallest public surface, mock only real external boundaries, and keep tests deterministic. Satisfy coverage gates with meaningful cases, never weaker thresholds.
- Engine feature, asset type, base class or setting changes also update the Feature Test starter in the same PR ([feature-test.md](feature-test.md)); its scaffold test joins the targeted set.
- Test projects, coverage gates and environment limits: [testing.md](../reference/testing.md). Approach: the [test-driven-development](../skills/test-driven-development/SKILL.md) skill.

## Architecture and documentation

- Product decisions: [engine-plan.md](../reference/engine-plan.md). Package map and coding standards: [architecture.md](../reference/architecture.md), with per-subsystem notes in [architecture/](../reference/architecture/). Package import boundaries are enforced by `no-restricted-imports` in `eslint.config.js`.
- UI talks to Babylon through `engineCommandBus` in `@babylonslate/core`; graph execution emits commands and never touches Babylon; file access goes through `ProjectStorage` / `createStorage()` and platform detection through `getHostPlatform()` in `@babylonslate/vfs`. Never call Capacitor plugins from UI.
- Update `docs/` and `.agents/reference/` in the same change as the behaviour they describe ([docs.md](docs.md)).

## Git: commit and push

- Commit and push without waiting for permission whenever you have meaningful changes: after each logical unit, before running verification, and before ending a turn that modified files.
- Commit messages are complete sentences.
- Before a PR is ready, push after every commit with `git push -u origin <branch>`. For fixes to a ready PR, batch the verified repairs into one push so each push starts one CI run.
- New branches are named `agent/<descriptive-name>-<suffix>`. Continue on an existing user or host-created branch; never rename historical branches.

## Pull requests and commit messages

The repository is public: everything in a commit, PR title, description, review or comment is published.

- A PR description is a short summary of the change: a few lines or a short bullet list, with no filler sections.
- Never include a link to an agent session, or any line that credits an agent or a requester: "Generated with" or "Written by" footers, co-author or session trailers, "Requested by" lines. Remove any that tooling adds, by editing the PR description or rewriting the commit before you push. The public hygiene check rejects them in commits and PRs.
- Never include secrets, tokens, credentials, `.env` contents, internal URLs, customer data, logs, stack traces or raw command output. Name the failing job instead.

## Merge to main

Distribution is a separate operation ([distribution.md](distribution.md)); nothing in this workflow authorizes packaging, signing, uploading or publishing.

Merge to `main` automatically when every gate passes; do not ask first. Completed work left on a branch is incomplete work.

### Completion reporting

- Never report repository changes as finished until GitHub confirms the PR is merged into `main`.
- When ending with unmerged changes, prominently warn that **unmerged work remains**, and name the branch and PR (or say there is none), the reason for stopping and what remains. Give the warning even when the user asked you to hold the PR; it does not authorize merging.
- Read-only answers, investigations, reviews and plans need no PR; describe their scope accurately.

### Merge gates (all required)

- The task is complete, not exploratory or waiting on the user.
- Targeted local checks cover the current changes and pass (prose-only changes: diff and link review).
- The latest Verify run for the head (`.github/workflows/verify.yml`) passes `static`, `unit` and all four `e2e` shards, and every other required check passes. Draft skips, missing, pending, cancelled or superseded runs are not a pass. A pull-request run tests the head merged with the base branch as it was when each job started, not GitHub's cached merge; a base that moves afterwards is not covered.
- No merge conflicts, no user hold ("PR only", "don't merge", "keep it draft"), and the session is not read-only.
- Branch protection and required reviews are satisfied; never admin-merge.

Leave the PR unmerged and report why for an incomplete or ambiguous task, a CI failure you cannot fix in the session, a conflict needing human judgement, a user hold, or a missing permission or service. Queued or running CI is not a blocker.

### Workflow

1. Commit, pass the targeted checks, then open a **draft** PR targeting `main` (or reuse the existing PR).
2. Count the open non-draft PRs targeting `main`, excluding this one. When fewer than four, mark this PR ready, once; never toggle draft status to restart CI. Otherwise keep it draft and wait with `pnpm --silent agent:wait slot --pr <number>`, rechecking just before marking ready; never change other agents' PRs. A slot result is not a reservation. An already-ready PR may take verified fixes and merge without a new slot.
3. Wait for CI on the current head with `pnpm --silent agent:wait ci --pr <number>`, then check the other required checks. Pending CI is a reason to wait, not to hand the task back.
4. On a failure, read the failed job's log, reproduce it locally where possible, fix the cause, rerun only the affected checks, and push the verified fix. Retry an unchanged run only on evidence of a transient infrastructure failure; never weaken checks or remove failing coverage.
5. Just before merging, refresh the head, checks and mergeability. If the head changed, check the new delta. Resolve routine conflicts, run checks for the resolution, push and wait for fresh CI.
6. Merge with a merge commit pinned to the verified head (`gh pr merge <number> --merge --match-head-commit <sha>` or the equivalent), then confirm GitHub reports it merged.
