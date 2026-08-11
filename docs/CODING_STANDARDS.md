# Coding standards

Short conventions for BabylonSlate. Tooling (ESLint, TypeScript strict) enforces what it can; this doc covers what reviewers check manually.

## Packages and boundaries

- `core`, `edit`, `assets`, `vfs`, `object-model`, `scripting`, `input`, `behaviour-tree` — no React or Babylon imports.
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
- Use `@babylonslate/ui` and semantic tokens (`bg-background`, `text-muted-foreground`, `text-vector`) — no raw hex colors in app code.
- Compose forms from `Field` + shadcn inputs (`Input`, `Select`, `Switch`, `Checkbox`) — no raw `<input>`, `<select>`, or `<textarea>` with hand-rolled Tailwind in `apps/editor/src`.
- Use `@babylonslate/editor-kit` panel composites (`PanelFrame`, `ToolbarStrip`) for docked panel chrome.
- Palette and token roles: [architecture/theming.md](architecture/theming.md). Edit tokens only in `packages/ui/src/styles/globals.css`. No brand accent chrome — saturated colors are type/status cues for small UI only.
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
- Per-package coverage is gated at 60%. Add tests or split out the untestable part with a documented exclusion — never lower a threshold to go green.
- Read [architecture/testing.md](architecture/testing.md) before writing DOM or gesture tests: jsdom lacks `PointerEvent` and `ResizeObserver`, which has already caused tests that passed without asserting anything.

## Git / PRs

- One roadmap slice per PR when possible.
- Update `docs/` in the same PR as behavioural or API changes.
- Run `pnpm verify` before marking ready.
