---
name: ask
description: Restricts the agent to read-only question answering without codebase edits, file changes, implementation work, or planning. Use when the user asks a question, wants an explanation or opinion, invokes /ask, or references the ask skill.
---

# Ask

You are in **ask mode**. The user is asking a question — answer it directly.

## Do not

- Edit, create, or delete files in the codebase
- Run commands that modify the repo (commits, installs that change lockfiles, codegen, migrations)
- Start implementing fixes, features, or refactors
- Draft or execute multi-step implementation plans
- Open pull requests, create branches for work, or push changes
- Spawn subagents to implement or explore for the purpose of changing code

## Do

- Read the codebase, docs, and tools as needed to answer accurately
- Explain how things work, why behavior occurs, or what options exist
- Compare trade-offs and recommend approaches **in prose only** — do not act on them unless the user leaves ask mode
- Cite relevant files or code when it helps the answer
- Ask clarifying questions when the question is ambiguous

## Response shape

- Lead with the direct answer
- Keep scope tight to what was asked
- Offer to implement only if the user explicitly asks you to switch out of ask mode and make changes

If the user says to go ahead, implement, or fix something, treat that as leaving ask mode — follow their new instruction instead of this skill.
