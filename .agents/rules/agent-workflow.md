# BabylonSlate Agent Rules

## Verification

- Always run `pnpm verify` before considering work complete.
- Add or update tests for new behavior in `packages/*`.
- Do not open PRs with failing CI.

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
- `pnpm verify` runs typecheck, lint, unit tests with coverage, and Playwright.

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
- Push after every commit with `git push -u origin <branch>`.
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
- `pnpm verify` passes locally.
- PR CI is green (`.github/workflows/verify.yml`).
- No unresolved merge conflicts.
- User has **not** explicitly asked to hold the PR open, keep it draft, or skip merge.
- Session is not read-only (e.g. Plan mode).
- A Verify **slot** is free (fewer than 2 counted non-draft PRs targeting `main`; **[#271](https://github.com/hideoutgames/BabylonSlate/pull/271) does not count**). If not, stay draft and stop — see [github-actions-pr-cadence.md](github-actions-pr-cadence.md).

### When merge is not reasonable (exceptions)

- Incomplete task, ambiguous requirements, or blocked on user decision.
- CI failures that cannot be fixed in-session.
- Merge conflicts needing human judgment.
- User explicitly requested "PR only", "don't merge", or "wait for review".
- No Verify slot: two counted non-draft PRs already target `main` (#271 excluded). Leave the draft and stop.

### Workflow

1. Open or update a PR targeting `main` using an available GitHub integration or authenticated GitHub CLI that supports the operation. Honor host permissions; if no authorized capability is available, report the limitation. Open it **draft**.
2. Keep the PR draft until local `pnpm verify` passes. Then mark ready **once** — not on the first push, and not if **2** counted non-draft PRs already target `main` (**#271 does not count**). If there is no slot, leave the draft and **stop**. Detail: [github-actions-pr-cadence.md](github-actions-pr-cadence.md).
3. After ready, avoid extra pushes; each synchronize restarts sharded Verify (`static` + `unit` + 7 e2e = 9 jobs). Fix any failing CI before merging.
4. **Merge the PR into `main` automatically** when all merge gates pass.
5. Prefer merge commits (not squash) when the PR contains multiple logical commits, unless the user specifies otherwise.
