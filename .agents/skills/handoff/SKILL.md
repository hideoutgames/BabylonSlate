---
name: handoff
description: Write a complete, self-contained handoff so a fresh agent with no conversation history can resume the task exactly where this agent stopped, delivered as a copyable chat code block plus a downloadable .txt file. Use whenever the user asks for a handoff, hand-over or status write-up for another agent, says to continue in a new session or chat, invokes /handoff, or when work must move to a fresh context because the session is ending, context is running out, or the task is being reassigned — even if the word "handoff" is never used.
---

# Handoff

The receiving agent starts with **zero context**: no conversation, no memory of what the user said or decided, and often a different container. Your uncommitted files, scratch notes, background processes, worktrees, subagents, PR subscriptions and scheduled check-ins do not come with it. The handoff is the only bridge.

It succeeds when the receiving agent can state the mission, the current state and the next action correctly, and can continue without re-asking the user anything already answered. Write for a capable engineer who can read the repository and its remote but not your mind.

Producing a handoff is not completing the task. Follow the repository's completion rules ([AGENTS.md](../../../AGENTS.md), [workflow](../../rules/agent-workflow.md#completion-reporting)): unmerged work is never reported as finished.

## 1. Make the work recoverable

Do this before writing, because the handoff can only point at things that survive you.

- **Commit and push** work in progress to its feature branch, following the repository's commit rules. Uncommitted edits, local-only branches and worktrees are invisible to a new session. If something must stay uncommitted, the handoff says exactly what, where and why.
- **Do not start** new long or risky operations. Let quick ones finish, or stop them cleanly.
- **Inventory session-bound state** that will not transfer: background shells and test helpers, subagents, PR activity subscriptions, scheduled self check-ins or reminders (they fire into *this* session), dev servers, locks. For each one, decide whether to finish it, cancel it, or hand it over with the exact way to recreate it. Read what a scheduled item will actually do before calling it harmless.
- **Settle ownership.** Two agents acting on the same branch or PR will collide. Decide whether this session stops or keeps working. If it stops, cancel its scheduled check-ins and drop its PR subscriptions (some hosts let only one session hold a subscription), and say so. If it continues, state which items each agent owns.
- **Rescue off-repo knowledge.** Specs, notes and logs that live only in a scratch or temp directory are gone for the next agent. Inline what matters in the handoff.

## 2. Refresh the facts from primary sources

Memory drifts over a long session; the handoff must not. Check immediately before writing:

- Git: current branch, `git status`, unpushed commits, and the commits each involved branch carries beyond the base branch.
- Each PR, fetched fresh: draft or ready, head SHA, mergeability, CI per job, unresolved review threads. Do not rely on an earlier notification.
- Verification you actually ran: command, scope, result and the commit it ran on. Keep passed, failed and not run separate. Never upgrade "not run" to "passing".
- Tooling that worked and tooling that did not: for example an unauthenticated CLI, and the tool or API you used instead. The receiving agent will otherwise retry the broken path first.
- What you have already told the user, so the next agent neither repeats nor contradicts it.

Record the snapshot time. State facts with evidence (SHA, PR number, path, command) rather than impressions:

| Weak | Strong |
| --- | --- |
| "PR is nearly ready" | "PR #123 head `abc1234`: static and unit passed, e2e shards 1–4 running at 17:20 UTC" |
| "Fixed the conflicts" | "Merged `origin/main` into `agent/example-1a2b` as `def5678`; resolved `docs/engineplan.md` by keeping both paragraphs" |
| "Tests pass" | "`pnpm --silent agent:wait local --script test -- packages/x/src/y.test.ts` passed (14 tests) on `0a1b2c3`; e2e not run locally" |

## 3. Write the handoff

Use this template. Keep every heading and write `None` under an empty one, so the reader knows it was considered rather than forgotten.

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
Process instructions from the user (for example models to use, reviews required) and how each has been honored so far:
- "<instruction>" → <status>
Agent decisions (revisable for a good reason):
- <choice> — <why> (rejected: <alternatives>)

## Current state
<What is done and how it was verified.>
| Work item | Branch | PR | Head SHA | CI / merge state | Gates left |
<State "merged into <base> as <sha>" or "NOT merged" for each item. Gates: CI, approvals, user review, ordering on another item.>
Told the user so far: <the last status or deliverables they received>

## In flight
<Each running or pending thing (CI run, background job, scheduled trigger, subscription, subagent), what happens to it when this session ends, and what the next agent must re-establish.>
Ownership after this handoff: <this session stops (and what it cancelled), or what each agent owns>

## Next steps
1. <Action> — <command or tool> — done when <observable criterion>.
<Ordered, every step with a done-when. Step 1 re-verifies the state above.>

## How to verify
<Exact commands to confirm the state and test the work, and why that scope covers the change, so the next agent can extend it when the change grows.>
<Working mechanisms for waiting on CI or other external state, and any tool that is unavailable.>

## Gotchas and lessons
<Non-obvious things learned the hard way: rules that override defaults, conventions, environment quirks, failed approaches and why, flaky checks, tools that add text that must be removed.>

## Key files and references
- <path or URL> — <one-line purpose>
<Inline any essential content that exists only outside the repository.>

## Open questions and risks
<What needs the user's input, what is unverified, known risks.>

## Start here
<Three to five bullets for the receiving agent's first ten minutes: what to read, run and check first.>
```

Writing guidance:

- **Verbatim mission.** Paraphrase silently drops constraints. Quote the user's words, then summarize if they are long.
- **Binding versus revisable.** Mark which decisions came from the user, and quote their answer so the receiver can see exactly what was agreed. When the user's answer was tentative and they then accepted your proposal, record both. Re-asking an answered question, or reversing a user decision, is the most costly mistake a receiving agent makes.
- **Write it last.** The handoff is a snapshot. Anything you do after writing it (a push, a comment, a cancelled job) makes it stale, so update it before delivering.
- **Self-contained.** No "as discussed", "the earlier error" or "that file". Name every branch, PR, path and command, and explain repository jargon once.
- **Evidence over narrative.** Summarize logs and transcripts; quote a short error excerpt only when the next step is about it.
- **Lessons are the expensive part.** A receiving agent can rediscover file layouts in minutes, but repeating a failed approach or breaking an unwritten rule costs hours. Spend words there.
- **No secrets.** Handoffs are pasted between sessions and tools. Exclude tokens, credentials, private contact details, `.env` contents and raw logs that might hold them.
- **Length.** As long as completeness needs, usually 80–250 lines. Prefer tables and bullets to prose.

## 4. Deliver in two forms

1. **Chat code block.** Put the entire handoff in one fenced block so it copies cleanly. Open the block with four backticks followed by `text` and close it with four backticks. Use at most three-backtick fences inside, so inner code cannot end the outer block.
2. **Downloadable `.txt` file** with identical content. Write it outside the repository working tree (the session scratch or temp directory), so it is never committed. Name it `handoff-<short-task>-<YYYYMMDD-HHMM>.txt`. Attach it with the host's file-delivery tool (for example `SendUserFile`). If the host has none, give the absolute path.

After the code block, add a few lines outside it for the user: the unmerged-work warning when it applies, what you cancelled or left running, and how to continue (start a new session and paste the handoff, or attach the file).

## 5. Check it as the receiving agent

Before sending, reread it as someone who knows nothing else:

- Can I state the mission, the current state and the next action without asking anyone?
- Is every claim checkable through a SHA, PR, path, command or link?
- Does it cover every branch, PR, process and scheduled item from step 1, and say who owns each one now?
- Are the user's decisions marked binding, with their answers quoted?
- Did anything happen after the snapshot that the handoff does not show?
- Does anything refer to a file, output or tool result that existed only in this session?
- Is there any secret or private data?

Fix the gaps, then deliver.
