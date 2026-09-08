---
name: wait-efficiently
description: Wait quietly for local verification or test scripts, pull-request Verify CI, and a free CI slot using the foreground agent-wait CLI. Use whenever development or PR delivery needs one of these waits.
---

# Wait efficiently

Use the repository helper to keep process monitoring, CLI polling, and full logs outside the conversation. Read the [delivery workflow](../../rules/agent-workflow.md) and [PR cadence](../../rules/github-actions-pr-cadence.md); waiting does not relax their gates.

## Launch once

From the repository root:

```sh
pnpm --silent agent:wait local --script verify:local
pnpm --silent agent:wait local --script test -- --project node packages/core
pnpm --silent agent:wait ci --pr 123
pnpm --silent agent:wait slot --pr 123
```

The default deadline is two hours; set `--timeout-seconds 10800` before the argument separator when a longer wait is explicitly needed. CI discovery has a separate ten-minute limit. The helper runs in the foreground, reports start and result records, and stores complete logs plus `result.json` in the unique OS temporary directory printed at start. Node, pnpm, git, and (for CI/slots) authenticated `gh` must already be available. The helper inherits the environment and configured package-script shell; it does not repair global configuration. See [testing guidance](../../../docs/architecture/testing.md#quiet-agent-waits) for Windows setup and result meanings.

## Retain the session

- Launch one helper and retain the host's returned process/session ID. Continue waiting on that same session; do not launch duplicate tests or watchers.
- Prefer a host-supported completion notification or a pending tool call. Otherwise use the longest process wait the host permits, with minimal output. Obey any host limit on blocking waits and required user updates.
- Report start, failure/blocker, and completion only, except when the host explicitly requires intermediate updates. Avoid repeated `gh` queries, log tails, and reasoning about unchanged progress. The helper owns individual polls.
- Do not invent a wakeup mechanism. T3 Code is unchanged; a host that requires periodic tool wakeups still consumes some tokens. This workflow reduces output and model work, not necessarily to zero.
- On interruption, cancel the existing session gracefully when supported. The helper handles SIGINT/SIGTERM and stops only its child tree. Never kill unrelated processes by executable name.

## Act on the terminal result

- `success` with exit code 0 means this operation passed. For PR eligibility, additionally require `deliveryEligible: true` in `result.json`, a matching current commit, and a clean unchanged working tree. Filters, dirty source, and later edits cannot certify a PR head.
- `failure`, `cancellation`, `timeout`, and `stale` never satisfy a gate. Read only bounded failure output or the necessary portion of the saved log when action is needed. Full logs are local artifacts; do not paste them into public PRs.
- A free slot is an observation, not a reservation: recheck capacity immediately before marking ready. The helper never opens, readies, or merges a PR.
- CI success covers the captured head's latest pull-request Verify run and all nine jobs. Still check other required checks, reviews, mergeability, and the current PR head immediately before merge.
- Continue fix → commit → local verification with `pnpm verify:local` → push → CI → merge as required by the delivery workflow. Do not automatically rerun tests or retry failed workflows without investigating the result.
