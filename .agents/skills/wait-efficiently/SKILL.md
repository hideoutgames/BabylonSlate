---
name: wait-efficiently
description: Wait quietly for local verification or test scripts, pull-request Verify CI, and a free CI slot using the foreground agent-wait CLI. Use whenever development or PR delivery needs one of these waits.
---

# Wait efficiently

`scripts/agent-wait.mjs` keeps process monitoring, polling and full logs out of the conversation. Waiting never relaxes the [delivery workflow](../../rules/agent-workflow.md) or the [PR cadence](../../rules/github-actions-pr-cadence.md); what to run is set by the [verification rules](../../rules/agent-workflow.md#verification).

## Launch once

From the repository root:

```sh
pnpm --silent agent:wait local --script test -- packages/core/src/project.test.ts
pnpm --silent agent:wait ci --pr 123
pnpm --silent agent:wait slot --pr 123
```

- Arguments after `--` go to the package script. On PowerShell, quote the separator as `'--'` when invoking `pnpm.ps1`.
- The default deadline is two hours; pass `--timeout-seconds <n>` before the separator for a longer wait. CI run discovery has its own ten-minute limit.
- The helper prints a start record with the log path, then one result record. Full output goes to `output.log` and the summary to `result.json` in a new temporary directory.
- Node, pnpm, git and, for `ci` and `slot`, an authenticated `gh` must already work. The helper inherits the environment and does not repair global configuration.
- Local runs still pass through the shared admission queue. Resource settings: [testing.md](../../reference/testing.md#local-test-execution); result details: [testing.md](../../reference/testing.md#quiet-agent-waits).

Run the helper in the foreground, keep its session until it returns, and never start a duplicate test or watcher.

## Act on the terminal result

- `success` (exit code 0) means only the selected operation passed; confirm it still covers the current change. Targeted checks do not produce the cumulative preflight certificate (`deliveryEligible: true`), and targeted delivery does not need it.
- `failure`, `cancellation`, `timeout` and `stale` never satisfy a gate. Read the bounded failure output, or only the part of `output.log` you need.
- A free slot is an observation, not a reservation: recheck capacity immediately before marking ready. The helper never opens, readies or merges a PR.
- CI success covers the captured head's latest pull-request Verify run and all six jobs. Other required checks, reviews, mergeability and the current head still need checking before merge.
- To interrupt, cancel the session gracefully: the helper handles SIGINT and SIGTERM and stops only its own child processes. Never kill processes by executable name.
