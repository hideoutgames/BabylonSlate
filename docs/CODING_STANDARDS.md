# Coding standards

Short conventions for BabylonSlate. Tooling (ESLint, TypeScript strict) enforces what it can; this doc covers what reviewers check manually.

## Packages and boundaries

- `core`, `edit`, `assets`, `vfs`, `object-model`, `scripting`, `scripting-nodes`, `bridge`, `runtime`, `debugger`, `anim-graph`, `shader-graph`, `input`, `behaviour-tree`, `exporter`, `source-control` — no React or Babylon imports (Capacitor banned too except `vfs` adapters).
- `navigation` — Recast wasm (`@recast-navigation/core` / `generators`) is allowed; no React, Babylon, Capacitor, or `@recast-navigation/babylon`.
- `physics` — Babylon Physics V2 (`HavokPlugin` / `PhysicsAggregate`) on a worker-local `NullEngine` Scene; no React, Capacitor, or editor Babylon packages (gui/loaders/inspector). `runtime` still must not import Babylon.
- `render` — Babylon only; no React.
- `runtime` — no Babylon or DOM.
- `apps/player` — Babylon runtime host; no React, Dockview, Capacitor, or editor chrome.
- Only `vfs` adapters touch Capacitor plugins directly.
- UI talks to Babylon via `engineCommandBus` in `@babylonslate/core` until the bridge supersedes hot paths.

## TypeScript

- `verbatimModuleSyntax`: use `import type` for type-only imports.
- Prefer `Result` and explicit errors over thrown exceptions in pure packages (as types land in `core`).
- No `any` without a one-line justification comment.

## Babylon.js

- Engine and scene work follows the BabylonJS skill. Agent rule: [`.cursor/rules/agent-workflow.mdc`](../.cursor/rules/agent-workflow.mdc).
- React editor chrome (Dockview, shadcn, `@babylonslate/ui`, editor-kit) is not Babylon GUI; use the editor-ui-components and shadcn skills for that.

## React / editor

- Chrome and dock tabs use `--chrome-row` (**28px**). Graph pin rows stay **44px** (`--touch-target`). Dockview tab strips are **18px** (fine pointer) / **26px** (coarse).
- Use `@babylonslate/ui` and semantic tokens (`bg-background`, `text-muted-foreground`, `text-primary`, `bg-node-event`) — no raw hex colors in app code.
- Compose forms from `Field` + shadcn inputs (`Input`, `Select`, `Switch`, `Checkbox`) — no raw `<input>`, `<select>`, or `<textarea>` with hand-rolled Tailwind in `apps/editor/src`. Inventory: [architecture/components.md](architecture/components.md).
- Use `@babylonslate/editor-kit` panel composites (`PanelFrame`, `ToolbarStrip`) for docked panel chrome.
- New asset editor tabs are DockView documents (`DockviewShell` + `window-catalog.ts`) so panels resize, dock together, and appear in the toolbar **Windows** menu. Do not use shadcn `Tabs` or a new `AssetDocumentWorkspace` page as the document shell. Agent rule: [`.cursor/rules/dockview-editor-tabs.mdc`](../.cursor/rules/dockview-editor-tabs.mdc).
- Palette and token roles: [architecture/theming.md](architecture/theming.md). Edit tokens only in `packages/ui/src/styles/globals.css`. `--primary` is ink; saturated pin/node/axis/success tokens are the chromatic cues.
- Use `flex` + `gap-*` for spacing, not `space-y-*`.
- Global `user-select: none` on the shell; wrap readable text in `SelectableText` from `@babylonslate/editor-kit`. Form `input` / `textarea` / `contenteditable` restore selection in `globals.css`.
- Use radius tokens (`rounded-md`, `rounded-lg`) — no hardcoded `border-radius` literals in editor CSS except token definitions.

## Display names

User-facing Event names, Details labels, node titles, pin labels, and enum options are **Title Case** with preserved acronyms (`2D Camera Width`, `Event Begin Play`, `Mesh Kind`). Do not sentence-case labels and do not split `2D`/`3D` into `2 d`.

- Format with `humanizePropertyLabel`, `formatEventMemberName`, and `formatEventTitle` in `@babylonslate/editor-kit`.
- Code identifiers stay unchanged (`flow.event.beginPlay`, `meshKind`, `onBeginPlay`, pin `id`s).
- Agent rule: [`.cursor/rules/display-names.mdc`](../.cursor/rules/display-names.mdc).

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

## Artwork and media

Never AI-generate artwork, videos, icons, 3D models, or similar media. Reuse Lucide / the project `iconLibrary` and existing `engine-logos/` branding. Capture the real running app when a screenshot or recording is required. Agent rule: [`.cursor/rules/no-ai-artwork.mdc`](../.cursor/rules/no-ai-artwork.mdc).

## Git / PRs

- One roadmap slice per PR when possible.
- Update `docs/` in the same PR as behavioural or API changes.
- Run `pnpm verify` before marking ready.
