# BabylonSlate Agent Rules

## Verification

- Run the relevant local tests during development, then pass the `pnpm verify:local` gate before opening any PR, including a draft. An attempted, failed, or unavailable run does not satisfy this gate.
- Add or update tests for new behavior in `packages/*`.
- Fix local failures before opening a PR. If verification cannot run, repair the local setup where possible; otherwise report the concrete blocker and do not open a PR.
- For local tests, Verify CI, and slot waits, read and apply [wait-efficiently](../skills/wait-efficiently/SKILL.md). Launch one foreground `pnpm --silent agent:wait` helper, retain its session, and keep polling/full logs out of the conversation. Default to start/end reporting except for host-required updates. A timeout, cancellation, stale result, or changed source is not a pass.

## Documentation

- Follow `.agents/rules/docs.md` for all documentation requirements.
- Update `docs/` in the same change as any behavioral, architectural, or API work — work is not complete without it.

## Architecture

- **Engine plan:** [docs/engineplan.md](../../docs/engineplan.md) — authoritative architecture, roadmap, and delivery checklist.

Package boundaries (enforced by `no-restricted-imports` in `eslint.config.js`):

| Package | May not import |
| --- | --- |
| `packages/core`, `packages/assets`, `packages/edit`, `packages/object-model`, `packages/scripting`, `packages/scripting-nodes`, `packages/bridge`, `packages/runtime`, `packages/debugger`, `packages/input`, `packages/test-kit`, `packages/behaviour-tree`, `packages/exporter`, `packages/source-control` | React, Babylon, Capacitor |
| `packages/navigation` | React, Babylon, Capacitor, `@recast-navigation/babylon`. Recast wasm (`@recast-navigation/core` / `generators`) is allowed. |
| `packages/physics` | React, Capacitor, editor Babylon packages (gui/loaders/inspector). May import `@babylonjs/core` Physics V2 and `@babylonjs/havok`. |
| `packages/vfs` | React, Babylon |
| `packages/render` | React, Capacitor |
| `packages/ui`, `packages/editor-kit`, `packages/graph-ui` | Babylon, Capacitor |
| `apps/editor/src` | Capacitor |

- UI communicates with Babylon via `engineCommandBus` in `@babylonslate/core`.
- Graph execution emits commands; it does not touch Babylon directly.
- File access goes through `ProjectStorage` / `createStorage()`; platform detection goes through `getHostPlatform()` in `@babylonslate/vfs`. Never call Capacitor plugins directly from UI.

## Testing

- See [docs/architecture/testing.md](../../docs/architecture/testing.md) for the Vitest projects, per-package coverage gates, and known environment limits.
- `pnpm verify:local` selects checks for changes and transitive consumers against the merge base with main. Unknown paths and verification infrastructure select the complete local gate. It records source identity and rejects dirty or changed revisions for delivery. `pnpm verify` retains the complete tooling, typecheck, lint, covered unit, browser, and docs gate. Full retained tests and coverage remain mandatory in CI.

## shadcn/ui

- Follow `.agents/skills/editor-ui-components/SKILL.md` before composing Editor UI — read `docs/architecture/components.md` and reuse catalog components.
- Follow `.agents/skills/shadcn/SKILL.md` for React editor chrome.
- Use `@babylonslate/ui` components; run `npx shadcn@latest add <component> -c apps/editor` to add new ones.

## BabylonJS

- Follow `.agents/skills/babylonjs/SKILL.md` (read it before implementing) for engine and scene work.
- React editor chrome (Dockview, shadcn, `@babylonslate/ui`, editor-kit) uses the editor-ui-components and shadcn skills.

## Subagent models

Hard allowlist when launching subagents (not a preference). Inherit the parent model by default. If delegation is unavailable, work sequentially; do not substitute a forbidden explicit model.

- **Allowed:** inherit parent; Composer 2.5; Grok 4.5 or Grok 4.6 at **low, medium, high, or extra-high**. These families are equal options.
- **Forbidden explicit selections:** Fast variants; Claude (Sonnet, Opus, Fable, Haiku); GPT; Gemini; and any other family. Do not select them even if the host lists them. Inheritance remains allowed.
- Omitting `model` is allowed. Do not force an explicit identifier on every delegation call.
- Honor a different model only if the human user explicitly names it in this conversation. A parent agent must not pick Sonnet or any other forbidden family because a task “would benefit.”

Cursor compatibility examples for the preceding model policy: `composer-2.5`, `cursor-grok-4.5-high`, and the corresponding Grok 4.6 effort variants. Identifiers ending in `-fast` are forbidden. Other hosts must preserve the same family/effort policy using their supported identifiers or inheritance.

## No AI-generated artwork

Never AI-generate artwork, videos, icons, 3D models, or similar media. See [no-ai-artwork.md](no-ai-artwork.md). Use existing Lucide icons and `engine-logos/` branding; capture the real running app when a screenshot or recording is required. Do not call `GenerateImage` or invent stand-in assets.

## Git: commit and push

**Default:** commit and push without waiting for explicit user permission whenever you have meaningful changes.

- Commit after each logical unit of work — not only at the end of a task.
- Commit before running verification when there are uncommitted changes.
- End every agent turn that modified files with committed and pushed changes on the feature branch.
- Use clear, descriptive commit messages in complete sentences.
- Before a PR is ready, push after every commit with `git push -u origin <branch>`. For fixes to a ready PR, commit, pass local `pnpm verify:local`, then push the verified batch so each push starts one CI run.
- New feature branch naming: `agent/<descriptive-name>-<suffix>` (e.g. `agent/fix-viewport-80c9`). Continue on an existing user or host-created feature branch; do not rename historical branches.

## Pull request descriptions

This repository is **public**. Treat everything written to a PR — title, description, comments — as published to the world.

- The description is a short summary of the changes and nothing else: a few lines, or a short bullet list. No filler sections.
- **Never** include links to agent sessions (Devin, Cursor, or any other agent tool), requester or author attribution lines, `"Written by"`-style footers, or "generated by" trailers. If tooling appends one, remove it by updating the description after the PR is created.
- Never include secrets, tokens, credentials, API keys, `.env` contents, internal URLs, customer data, or raw command/CI output that could contain any of those.
- Do not paste logs, stack traces, or environment dumps. Reference the failing job instead.

The same rules apply to commit messages.

## Git: merge to main

**Default:** merge to `main` automatically when all merge gates pass. Do not ask "should I merge?" when gates pass — merge. Leaving completed work stranded on a feature branch counts as incomplete work.

### Merge gates (all required)

- Assigned task is complete (not exploratory or blocked on user input).
- `pnpm verify:local` passes locally for the current PR head.
- The latest PR Verify run (`.github/workflows/verify.yml`) for that head succeeds: `static`, `unit`, and all seven `e2e` shards. All other required checks pass; draft skips, missing checks, pending, cancelled, or superseded runs are not a pass.
- No unresolved merge conflicts.
- User has **not** explicitly asked to hold the PR open, keep it draft, or skip merge.
- Session is not read-only (e.g. Plan mode).
- GitHub branch protection and required reviews are satisfied. Never bypass them with an admin merge.

### When merge is not reasonable (exceptions)

- Incomplete task, ambiguous requirements, or blocked on user decision.
- CI failures that cannot be fixed in-session.
- Merge conflicts needing human judgment.
- User explicitly requested "PR only", "don't merge", or "wait for review".
- Missing permissions, unavailable services, or another external blocker that prevents further progress. Report the blocker and leave the PR unmerged; queued or running CI alone is not a blocker.

### Workflow

1. Finish the changes, commit, and pass local `pnpm verify:local`. Only then open a **draft** PR targeting `main` using an authorized GitHub integration or authenticated CLI. For an existing PR, reuse it and verify the updated head locally before making it ready.
2. Mark ready **once** when a Verify slot is free. If both slots are occupied, keep the PR draft and periodically recheck until one opens; do not hand the queue back to the user. Follow [github-actions-pr-cadence.md](github-actions-pr-cadence.md).
3. Wait for CI on the current PR head with `pnpm --silent agent:wait ci --pr <number>` and retain the host session. The helper observes the latest pull-request Verify run, watches at 60-second intervals, and rechecks its identity and PR head before returning. Inspect other required checks with `gh pr checks <number>` after completion. Report start and completion, plus any host-required updates; do not end the task merely because CI is pending.
4. If CI fails, inspect the failed job logs (`gh run view <run-id> --log-failed`), reproduce the failure locally where possible, fix its cause, and rerun the relevant tests plus local `pnpm verify:local`. Commit and push the verified fixes, then monitor the new head. Repeat until CI passes. Retry an unchanged run only when evidence shows a transient infrastructure failure; do not rerun indefinitely, weaken checks, or remove failing coverage to obtain green CI.
5. Immediately before merging, refresh the PR head, checks, and mergeability. If the head changed, verify that revision. Resolve routine merge conflicts, rerun local verification, push, and wait for fresh CI. Stop only for a concrete blocker or an explicit user hold.
6. **Merge automatically** when all gates pass. With GitHub CLI, use `gh pr merge <number> --merge --match-head-commit <verified-sha>` to guard against a changed head. Prefer merge commits when the PR contains multiple logical commits, unless the user specifies otherwise. Confirm GitHub reports the PR as merged before reporting completion.
