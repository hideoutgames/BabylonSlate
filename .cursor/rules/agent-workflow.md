# BabylonSlate Agent Rules

## Verification

- Always run `pnpm verify` before considering work complete.
- Add or update tests for new behavior in `packages/*`.
- Do not open PRs with failing CI.

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
