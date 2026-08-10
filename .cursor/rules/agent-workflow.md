# BabylonSlate Agent Rules

## Verification

- Always run `pnpm verify` before considering work complete.
- Add or update tests for new behavior in `packages/*`.
- Do not open PRs with failing CI.

## Documentation

- Follow `.cursor/rules/docs.md` for all documentation requirements.
- Update `docs/` in the same change as any behavioral, architectural, or API work — work is not complete without it.

## Architecture

- `packages/engine` must not import React.
- UI communicates with Babylon via `engineCommandBus` in `@babylonslate/shared`.
- Graph execution emits commands; it does not touch Babylon directly.
- File access goes through `ProjectStorage` / `createStorage()` — never call Capacitor plugins directly from UI panels.

## shadcn/ui

- Follow `.cursor/skills/shadcn/SKILL.md` for all UI work.
- Use `@babylonslate/ui` components; run `npx shadcn@latest add <component> -c apps/editor` to add new ones.

## BabylonJS

- Follow `.cursor/skills/BabylonJS/SKILL.md` for engine and scene work.

## Git: merge to main

When agent work is complete and `pnpm verify` passes:

1. Commit and push all changes on the feature branch.
2. Open or update the PR targeting `main`.
3. Fix any failing CI before merging.
4. Mark draft PRs as ready for review once verification passes.
5. Merge the PR into `main` when the user asks to ship/merge, or when the task is fully complete and no review blockers remain.
6. Do not leave completed foundation work stranded on `cursor/*` branches.

Prefer merge commits (not squash) when the PR contains multiple logical commits, unless the user specifies otherwise.
