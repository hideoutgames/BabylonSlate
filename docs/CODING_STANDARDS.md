# Coding standards

Short conventions for BabylonSlate. Tooling (ESLint, TypeScript strict) enforces what it can; this doc covers what reviewers check manually.

## Packages and boundaries

- `core`, `vfs`, `object-model`, `scripting`, `input`, `behaviour-tree` — no React or Babylon imports.
- `render` — Babylon only; no React.
- `runtime` — no Babylon or DOM.
- Only `vfs` adapters touch Capacitor plugins directly.
- UI talks to Babylon via `engineCommandBus` in `@babylonslate/core` until the bridge supersedes hot paths.

## TypeScript

- `verbatimModuleSyntax`: use `import type` for type-only imports.
- Prefer `Result` and explicit errors over thrown exceptions in pure packages (as types land in `core`).
- No `any` without a one-line justification comment.

## React / editor

- Minimum **44px** touch targets on interactive chrome (buttons, tabs, grips).
- Use `@babylonslate/ui` and semantic tokens (`bg-background`, `text-muted-foreground`) — no raw hex colors in app code.
- Use `flex` + `gap-*` for spacing, not `space-y-*`.
- Global `user-select: none` on the shell; wrap readable text in `SelectableText` from `@babylonslate/editor-kit`.
- Use radius tokens (`rounded-md`, `rounded-lg`) — no hardcoded `border-radius` literals in editor CSS except token definitions.

## Performance (iPad baseline)

See [design/perf-budget.md](design/perf-budget.md). In particular:

- No per-actor per-frame allocation in render sync paths (reuse scratch math objects).
- Do not construct `Texture` outside the resource cache (lint rule when `render` lands P4 machinery).
- Every scene mutation that should appear in the viewport must mark the viewport dirty.

## Tests

- Behaviour changes need tests in the owning package.
- Golden files for byte-exact surfaces (containers, compiler output).
- TDD for new pure logic; see `.cursor/skills/test-driven-development/SKILL.md`.

## Git / PRs

- One roadmap slice per PR when possible.
- Update `docs/` in the same PR as behavioural or API changes.
- Run `pnpm verify` before marking ready.
