---
name: investigate
description: Investigate the codebase based on the user's prompt in read-only mode. Performs a deep, thorough investigation and dispatches more sub-agents as the scope grows. Use when the user asks to investigate, trace, map, audit, or explain how a large area of the repo works, invokes /investigate, or references the investigate skill.
---

# Investigate

Investigate the codebase based on users prompt, do not make any code changes or modify anything. This is a read-only mode. Perform a deep and thorough investigation into what the user requested. If the investigation is for larger parts of the codebase dispatch sub-agents to investigate the various parts. The larger the investigation, the more sub-agents. Your job will be to keep track of the context of the investigation.

## Do not

- Edit, create, or delete files
- Run commands that write to the repo (commits, installs that change lockfiles, codegen, migrations, formatters that write)
- Start implementing fixes, features, or refactors
- Open pull requests, create branches, or push
- Leave leftover agent notes, scratch files, or "investigation dumps" on disk
- Ask sub-agents to change code

Read-only git and search are allowed (`git log`, `git show`, `git grep`, `rg`, `Read`). Prefer tools that cannot mutate.

If the user later says to go ahead, implement, or fix something, treat that as leaving investigate mode — follow their new instruction instead of this skill.

## Vs ask

| Skill | Use |
| --- | --- |
| [ask](../ask/SKILL.md) | Short question, one area, a direct answer is enough |
| **investigate** | Deep or cross-cutting question; need maps, traces, or several packages |

Do not stay in ask-mode brevity. Investigate until the prompt is answered with evidence.

## Parent job: keep context

You are the coordinator, not a second explorer who dumps the whole tree into one context window.

1. Restate the question as a scoped brief (what to find, what is out of scope).
2. Split the brief into independent slices (packages, apps, docs, tests, git history).
3. Dispatch slices in parallel. Scale agent count with breadth:
   - One file or one function → no sub-agent; read it yourself
   - One package or one feature → 1–2 `explore` agents
   - Several packages / editor + engine + docs → one agent per slice, in parallel
   - Repo-wide / "how does X work end-to-end" → more agents (package, call sites, tests, docs, git). Cap a first wave at about 6; run a second wave only for gaps
4. Hold a running map: slice → agent → findings, contradictions, open questions.
5. After the first wave, only dispatch follow-ups for holes or conflicts. Do not re-explore settled slices.
6. Synthesize one report. Sub-agent notes stay internal; the user sees the merged answer.

Each sub-agent prompt must include: the user question, that slice's scope, paths to start from, "read-only — do not modify files", and what to return (files, symbols, data flow, uncertainties). Sub-agents have no parent conversation — paste the brief.

**Sub-agent type:** `explore` for code search. Use `generalPurpose` only if the slice needs git history or docs fetch that explore cannot do. Omit `model` or use the repo allowlist in `docs/agents/issue-tracker.md`. Never Fast / Claude / GPT / Gemini.

## How to investigate

- Start from the user's terms, then follow imports, command-bus events, and package boundaries (`docs/architecture/overview.md`, `docs/engineplan.md`).
- Confirm behavior in code, not only docs. When they disagree, say so and cite both.
- Prefer primary sources: types, exporters, tests that name the behavior.
- Record file paths and symbol names. Quote small hunks when they settle a claim.
- Note test coverage and e2e only when they prove or contradict the claim.
- Stop when further files would not change the answer. Depth means following the real path, not reading every sibling.

## Report shape

Lead with the answer to the user's question.

Then include, as relevant:

- **What exists** — components, APIs, data flow
- **Where** — packages, files, symbols
- **How it connects** — callers, bus commands, persistence
- **Gaps / risks** — missing tests, docs drift, dead paths
- **Open questions** — only what the tree cannot answer

Do not recommend a patch list unless asked. Do not switch to an implementation plan.
