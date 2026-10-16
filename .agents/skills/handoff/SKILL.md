---
name: handoff
description: Write a complete, self-contained handoff so a fresh agent with no conversation history can resume the task exactly where this agent stopped, delivered as a copyable chat code block plus a downloadable .txt file. Use whenever the user asks for a handoff, hand-over or status write-up for another agent, says to continue in a new session or chat, invokes /handoff, or when work must move to a fresh context because the session is ending, context is running out, or the task is being reassigned — even if the word "handoff" is never used.
---

# Handoff

The receiving agent starts with no conversation, no memory of the user's decisions and often a different container; this session's uncommitted files, scratch notes, processes, worktrees, subagents, PR subscriptions and scheduled check-ins do not come with it. It must be able to state the mission, the current state and the next action, and continue without re-asking anything already answered.

A handoff does not complete the task; unmerged work is never reported as finished ([completion reporting](../../rules/agent-workflow.md#completion-reporting)).

## 1. Make the work recoverable

Do this first; the handoff can only point at what survives this session.

- **Commit and push** work in progress to its feature branch. If something must stay uncommitted, say what, where and why.
- **Do not start** long or risky operations; let quick ones finish or stop them cleanly.
- **Inventory session-bound state**: background shells and test helpers, subagents, PR activity subscriptions, scheduled check-ins (they fire into this session), dev servers and locks. Finish, cancel or hand over each, with the exact way to recreate it. Read what a scheduled item will do before calling it harmless.
- **Settle ownership.** Two agents on one branch or PR collide. If this session stops, cancel its check-ins, drop its PR subscriptions (some hosts allow one subscriber) and tell the user how to stop or archive it; if it continues, state what each agent owns.
- **Rescue off-repo knowledge.** Inline what matters from notes and logs that exist only in a scratch or temp directory.

## 2. Refresh the facts from primary sources

Check immediately before writing:

- Git: the current branch, `git status`, unpushed commits, and the commits each involved branch carries beyond its base.
- Each PR, fetched fresh: draft or ready, head SHA, mergeability, CI per job and unresolved review threads.
- Verification you actually ran: command, scope, result and commit. Keep passed, failed and not run separate.
- Tooling that worked and tooling that did not, and what you used instead.
- What you have already told the user.

Record the snapshot time and copy times, IDs and quoted text from tool output. State facts with evidence: not "Tests pass" but "`pnpm --silent agent:wait local --script test -- packages/x/src/y.test.ts` passed (14 tests) on `0a1b2c3`; e2e not run locally".

## 3. Write the handoff

Use this template; keep every heading and write `None` under an empty one. Write it last, since later actions make it stale, and leave out tokens, credentials, private contact details, `.env` contents and raw logs.

```text
# Handoff: <task in a few words>

Snapshot: <ISO 8601 time with zone> · Repository: <owner/repo> · Base: <branch>@<short sha>
Session link (if the host provides one): <link>

## Mission
<The user's original request, quoted verbatim.>
<Every later user instruction, correction or constraint that changed scope, verbatim, in order.>

## Decisions already made
User decisions (binding; do not ask again):
- <question> → "<the user's words, or the option they chose quoted in full>"
User process instructions and how each has been honored:
- "<instruction>" → <status>
Agent decisions (revisable for a good reason):
- <choice> — <why> (rejected: <alternatives>)

## Current state
<What is done and how it was verified.>
| Work item | Branch | PR | Head SHA | CI / merge state | Gates left |
<"merged into <base> as <sha>" or "NOT merged" for each item.>
Told the user so far: <the last status or deliverables they received>

## In flight
<Each CI run, background job, scheduled task, subscription or subagent, what happens to it when this session ends, and what the next agent must re-establish.>
Ownership after this handoff: <this session stops (and what it cancelled), or what each agent owns>

## Next steps
1. <Action> — <command or tool> — done when <observable criterion>.
<Ordered; step 1 re-verifies the state above.>

## How to verify
<Exact commands runnable from a fresh shell, why that scope covers the change, and how to wait on CI or other external state.>

## Gotchas and lessons
<Rules that override defaults, environment quirks, failed approaches and why, flaky checks.>

## Key files and references
- <path or URL> — <one-line purpose>

## Open questions and risks
<What needs the user's input, what is unverified, known risks.>

## Start here
<Three to five bullets for the receiving agent's first ten minutes.>
```

## 4. Deliver in two forms

1. **Chat code block.** Put the whole handoff in one block opened with four backticks followed by `text` and closed with four backticks. Use at most three-backtick fences inside.
2. **A `.txt` file** with identical content, written outside the working tree (the session scratch or temp directory) and named `handoff-<short-task>-<YYYYMMDD-HHMM>.txt`. Attach it with the host's file-delivery tool (SendUserFile in Claude Code), or give the absolute path.

After the block, tell the user in a few lines: the unmerged-work warning when it applies, what you cancelled or left running, and how to continue (paste the handoff into a new session, or attach the file).

## 5. Check it as the receiving agent

Before sending, confirm that nothing happened after the snapshot and that nothing refers to output that existed only in this session.
