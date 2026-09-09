---
name: wait-efficiently
description: Wait quietly for local verification or test scripts, pull-request Verify CI, and a free CI slot using the foreground agent-wait CLI. Use whenever development or PR delivery needs one of these waits.
---

# Wait efficiently

Use the repository helper to keep process monitoring, CLI polling, and full logs outside the conversation. Read the [delivery workflow](../../rules/agent-workflow.md) and [PR cadence](../../rules/github-actions-pr-cadence.md); waiting does not relax their gates.

## Launch once

From the repository root:

```sh
pnpm --silent agent:wait local --script test -- packages/core/src/project.test.ts
pnpm --silent agent:wait ci --pr 123
pnpm --silent agent:wait slot --pr 123
```

The default deadline is two hours; set `--timeout-seconds 10800` before the argument separator when a longer wait is explicitly needed. CI discovery has a separate ten-minute limit. The helper runs in the foreground, reports start and result records, and stores complete logs plus `result.json` in the unique OS temporary directory printed at start. Node, pnpm, git, and (for CI/slots) authenticated `gh` must already be available. The helper inherits the environment and configured package-script shell; it does not repair global configuration. See [testing guidance](../../../docs/architecture/testing.md#quiet-agent-waits) for Windows setup and result meanings.

## Choose the smallest required command

- Run explicit test files/cases for the changed behavior and directly affected consumers. Inspect the package script first so a filter is not rejected or silently ignored. On PowerShell, quote the separator as `'--'` when invoking `pnpm.ps1`.
- Before opening/updating a PR, use that targeted set and relevant scoped lint/typechecks. Do not automatically invoke cumulative `verify:local`, full `verify`, coverage, an unfiltered editor/browser suite, or workspace-wide typechecking. These require an explicit user request, even for public API, lockfile, infrastructure or CI repairs.
- Instruction/prose-only edits need diff/link checks, not application tests or a docs build. After a repair, rerun only affected checks and retain justified results for unchanged behavior.
- Required GitHub CI still runs its configured exhaustive checks. Do not change CI gates to match local scope.
- Keep the default shared profile while agents overlap. Three one-worker phases can be admitted when aggregate memory and host headroom allow; Node tooling uses a 0.75 GiB reservation, while Node unit tests, focused tests, owner typechecks, and docs builds use 1.5 GiB. Heavy application builds retain two slots and 2 GiB. `BL_TEST_PROFILE=fast` is for one active agent and must not be used to crowd out shared work.
- Read the machine settings from the common [local resource configuration](../../../docs/architecture/testing.md#local-test-execution). Low-memory mode keeps 3 GiB host headroom and one heavy phase; smaller fitting jobs may bypass a blocked older job only a bounded number of times. Shared artifacts must pass source, build-environment, toolchain, and file-integrity checks. Use the repository runner so new worktrees share these settings automatically; do not bypass admission or change per-worktree limits to force a run.

## Retain the session

- Launch one helper and retain the host's returned process/session ID. Continue waiting on that same session; do not launch duplicate tests or watchers.
- Prefer a host-supported completion notification or a pending tool call. Otherwise use the longest process wait the host permits, with minimal output. Obey any host limit on blocking waits and required user updates.
- Report start, failure/blocker, and completion only, except when the host explicitly requires intermediate updates. Avoid repeated `gh` queries, log tails, and reasoning about unchanged progress. The helper owns individual polls.
- Do not invent a wakeup mechanism. T3 Code is unchanged; a host that requires periodic tool wakeups still consumes some tokens. This workflow reduces output and model work, not necessarily to zero.
- On interruption, cancel the existing session gracefully when supported. The helper handles SIGINT/SIGTERM and stops only its child tree. Never kill unrelated processes by executable name.

## Act on the terminal result

- `success` with exit code 0 means only the selected operation passed. Record its command, scope and revision, and confirm it still covers the current change. Targeted checks intentionally do not produce the cumulative preflight certificate (`deliveryEligible: true`); that flag is not required for targeted PR delivery. If the user explicitly requests cumulative verification, its certificate still requires a clean unchanged head. Never reuse a result after relevant source/configuration changes.
- `failure`, `cancellation`, `timeout`, and `stale` never satisfy a gate. Read only bounded failure output or the necessary portion of the saved log when action is needed. Full logs are local artifacts; do not paste them into public PRs.
- A free slot is an observation, not a reservation: recheck capacity immediately before marking ready. The helper never opens, readies, or merges a PR.
- CI success covers the captured head's latest pull-request Verify run and all nine jobs. Still check other required checks, reviews, mergeability, and the current PR head immediately before merge.
- Continue fix → commit → targeted verification of the repair → push → CI → merge as required by the delivery workflow. Do not automatically rerun tests or retry failed workflows without investigating the result.
