# UI theming

Canonical tokens live in [`packages/ui/src/styles/globals.css`](../../packages/ui/src/styles/globals.css). Tailwind v4 maps them via `@theme inline`; components use semantic utilities (`bg-background`, `text-foreground`, `text-vector`, …) — not raw hex in app code.

The editor defaults to dark mode (`<html class="dark">`). A runtime appearance toggle is planned under Engine Settings.

## Theme source: Minimal Neutral (tweakcn)

The shadcn theme foundation is **[Minimal Neutral](https://tweakcn.com/themes/cmho4nr9l000h04l1gu419ckw)** exported as Tailwind v4 OKLCH variables. Geist remains the UI font; tweakcn’s system font stack is not used.

When updating the theme:

1. Export **Tailwind v4 / OKLCH** from tweakcn for Minimal Neutral.
2. Replace the `:root` and `.dark` semantic blocks in `globals.css`.
3. Re-apply the **BabylonSlate extension block** (below) — do not overwrite engine-specific tokens.

## Design philosophy

BabylonSlate is a game engine editor: keep chrome quiet and clutter low.

- **No brand accent color.** Primary actions, focus rings, and tab indicators use the text/icon color (`--foreground` / `--primary` aliases of that ink). Minimal Neutral’s default sidebar-primary blue is overridden to ink.
- **Avoid decorative highlights.** Prefer borders, weight, and layout over saturated underlines or glow.
- **Saturated colors are type cues**, reserved for small UI (pins, property rows, graph wires) and status — not shell chrome.

## BabylonSlate extension tokens

These are **not** part of the tweakcn export; merge them after every theme import:

| Token | Purpose |
| --- | --- |
| `--success` | Positive status |
| `--vector` | Vector / pin type cue (orange) |
| `--chrome-tab-active` | Active document tab fill (`var(--card)`) |
| `--chrome-tab-accent` | Tab indicator (`var(--foreground)`) |
| `--touch-target` | Minimum interactive size (`44px`) |

Charts (`--chart-1`…`--chart-5`) come from Minimal Neutral; type/status colors can be remapped in the extension block when needed.

## Base palettes (Minimal Neutral, dark default)

| Role | Dark (OKLCH) | Light (OKLCH) |
| --- | --- | --- |
| Background | `oklch(0.145 0 0)` | `oklch(1 0 0)` |
| Card / raised | `oklch(0.205 0 0)` | `oklch(1 0 0)` |
| Popover | `oklch(0.269 0 0)` | `oklch(1 0 0)` |
| Border | `oklch(0.275 0 0)` | `oklch(0.922 0 0)` |
| Foreground | `oklch(0.985 0 0)` | `oklch(0.145 0 0)` |

Muted text uses Minimal Neutral `--muted-foreground`.

## Action and status tokens

| Role | Token | Notes |
| --- | --- | --- |
| Default actions / ink | `--primary` | Same as text/icon color |
| Focus / tab indicator | `--ring`, `--chrome-tab-accent` | Text/icon color |
| Destructive | `--destructive` | Errors and destructive actions (Minimal Neutral red) |
| Success | `--success` | BabylonSlate extension |

## Type / value colors

| Token | Use |
| --- | --- |
| `--vector` (`text-vector`, `bg-vector`) | Vector values and related pins |

Further type colors land here as those surfaces ship — not as shell accents.

## Surfaces

Secondary fills use `--card`, `--popover`, `--secondary`, `--muted`, `--accent`, `--sidebar`, and `--chrome-tab-active`. Borders map to `--border`, `--input`, and `--sidebar-border`.

## Viewport

`packages/render` sets Babylon `scene.clearColor` to match dark `--background` (`oklch(0.145 0 0)` ≈ `#252525`) so the 3D viewport matches the shell.

## UI composition

Editor chrome and panels compose from `@babylonslate/ui` (shadcn) and `@babylonslate/editor-kit` (panel frame, toolbar strip). Do not add raw styled `<input>`, `<select>`, or `<button>` in `apps/editor/src` — use Field + shadcn primitives.

Dev-only **Component Gallery**: `/?test=1&gallery=1` renders every installed primitive for on-device visual checks.
