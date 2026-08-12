# UI theming

Canonical tokens live in [`packages/ui/src/styles/globals.css`](../../packages/ui/src/styles/globals.css). Tailwind v4 maps them via `@theme inline`; components use semantic utilities (`bg-background`, `text-primary`, `bg-node-event`, `text-axis-x`, …) — not raw hex in app code.

The editor defaults to dark mode (`<html class="dark">`). A runtime appearance toggle is planned under Engine Settings.

## Source scanning

Tailwind v4 detects sources relative to the CSS entry, which here lives in `packages/ui/src/styles`. Every workspace package that renders UI is therefore listed with `@source` in `globals.css`. Without those entries, a utility used *only* by a workspace component (dialog centering, for example) is never generated, and the failure is silent — the class is on the element with no rule behind it. Add an `@source` line when a new package starts rendering components.

## Theme source

The shell is an **Unreal-inspired** layered charcoal with a cool blue chroma — not the old Minimal Neutral ink-on-near-black export. Geist remains the UI font. Edit `:root` and `.dark` in `globals.css` directly; do not re-import a tweakcn preset over the pin/node tokens.

Dark `--background` lightness stays at or above `0.20` (no complete black). `apps/editor/src/shell/design-tokens.test.ts` asserts that floor, chromatic `--primary`, and the pin/node token set.

## Design philosophy

BabylonSlate is a game engine editor: chrome should be quiet, but **selection and types must be obvious**.

- **Primary is the selection accent** (Unreal-like blue). Focus rings, active tabs (`--chrome-tab-accent`), selected outliner rows, and default buttons use `--primary`.
- **Layered surfaces** differentiate chrome, side panels, and canvases (`--background` < `--sidebar` < `--card` < `--popover` / `--muted`).
- **Saturated pin/node colors are type cues** for visual scripting and vector axes — not whole toolbars.
- **Sparse action accents.** Play uses `--success`. Destructive actions use `--destructive`.

## Surface ladder (dark default)

| Role | Token | Dark OKLCH | Approx |
| --- | --- | --- | --- |
| Viewport / graph canvas | `--background` | `oklch(0.28 0.014 250)` | `#242a30` |
| Side panels (`PanelFrame`) | `--sidebar` | `oklch(0.32 0.012 250)` | `#2e3339` |
| Chrome / raised cards | `--card` | `oklch(0.34 0.012 250)` | `#33393e` |
| Headers / category bars | `--secondary` / `--muted` | `oklch(0.37 0.012 250)` | `#3b4046` |
| Menus / viewport overlay | `--popover` | `oklch(0.38 0.012 250)` | `#3e4349` |
| Hover / selection wash | `--accent` | `oklch(0.42 0.02 250)` | `#454e58` |

Light mode uses the same roles with cool off-whites and a darker blue `--primary` for contrast.

## Action and status tokens

| Role | Token | Notes |
| --- | --- | --- |
| Selection / default actions | `--primary` | Blue accent, not ink |
| Focus / tab indicator | `--ring`, `--chrome-tab-accent` | `var(--primary)` |
| Destructive | `--destructive` | Errors and destructive actions |
| Success / Play | `--success` | Positive status and the global Play control |

## Pin type colors

Blueprint-style mapping in `globals.css`. `graph-ui` resolves `pin.type.kind` → `var(--pin-*)` in [`node-theme.ts`](../../packages/graph-ui/src/node-theme.ts). `--vector` aliases `--pin-vector`.

| Token | Kinds |
| --- | --- |
| `--pin-exec` | exec (white) |
| `--pin-bool` | bool (red) |
| `--pin-int` | int (cyan) |
| `--pin-float` | float (green) |
| `--pin-string` | string (magenta) |
| `--pin-vector` | vec2 / vec3 / vec4 (yellow) |
| `--pin-rotator` | rotator |
| `--pin-transform` | transform |
| `--pin-color` | color |
| `--pin-object` | objectRef |
| `--pin-actor` | actorRef |
| `--pin-struct` | structRef |
| `--pin-enum` | enumRef |
| `--pin-wildcard` | resolvingWildcard / boxedWildcard / unknown |
| `--pin-delegate` | delegate |

Arrays use the element color; maps use the value color.

## Node role colors

Title-bar fills for Blueprint-like nodes:

| Token | Role |
| --- | --- |
| `--node-event` | `flow.event.*` / titles starting `Event` |
| `--node-function` | default impure calls |
| `--node-pure` | `pure` (math, getters) |
| `--node-flow` | flow control (Branch, Sequence) |
| `--node-variable` | Get Variable |
| `--node-variable-set` | Set Variable |
| `--node-latent` | timers / `latent` |
| `--node-debug` | debug category |
| `--node-title-foreground` | title text on those bars |

## Graph sizing tokens

| Token | Value | Use |
| --- | --- | --- |
| `--touch-target` | `44px` | Graph pin rows and remaining large hit boxes |
| `--chrome-row` | `28px` | Editor chrome, panel headers, property rows, catalog item rows |
| `--graph-pin-size` | `16px` | Visual pin diamond/circle |
| `--graph-edge-exec` | `5px` | Exec wire stroke |
| `--graph-edge-data` | `4px` | Data wire stroke |

Dockview tab strips: **18px** fine pointer, **26px** coarse (`apps/editor/src/shell/dockview-theme.css`). Tree rows are 32px.

## Axis colors

Vector scrub labels: `--axis-x` → `--destructive`, `--axis-y` → `--success`, `--axis-z` → `--primary` (`text-axis-x` / `y` / `z`).

## Other extension tokens

| Token | Purpose |
| --- | --- |
| `--chrome-row` | Compact chrome / panel header height (28px) |
| `--chrome-tab-active` | Active document tab fill (`var(--card)`) |
| `--chrome-tab-accent` | Tab indicator (`var(--primary)`) |

## Viewport

`packages/render` sets Babylon `scene.clearColor` from `EDITOR_CLEAR_COLOR` to match dark `--background` (`oklch(0.28 0.014 250)` ≈ `#242a30`).

Toolbar `DropdownMenu`s (Debug, Settings, Add) default to `modal={false}` so they do not paint a full-viewport `position: fixed` backdrop over the Babylon canvas. On iPad WKWebView that overlay composites as a full black page. Dialog / Sheet / AlertDialog stay modal.

`DropdownMenuLabel` is a Base UI `Menu.GroupLabel` and must sit inside `DropdownMenuGroup`. Opening Debug without that group throws (production error #31) and unmounts the editor to a black screen.

`#root` uses `isolation: isolate` so Base UI portals stack above the app instead of fighting chrome `z-index`. `body` is `position: relative` so iOS 26+ visual-viewport backdrops still cover the shell.

## UI composition

Editor chrome and panels compose from `@babylonslate/ui` (shadcn) and `@babylonslate/editor-kit` (panel frame, toolbar strip). Do not add raw styled `<input>`, `<select>`, or `<button>` in `apps/editor/src` — use Field + shadcn primitives.

**Action vs pressed:**

| Treatment | Use |
| --- | --- |
| `Button variant="outline"` | Visible actions (chrome Save/Undo, panel Add/Remove, catalog primary controls) |
| `Button variant="ghost"` | Tabs, menu items, icon-only close |
| `Toggle` / `ToggleGroup` `variant="outline"` | Exclusive tools; selected item uses secondary fill + `aria-pressed` |
| Catalog / folder / outliner selected | `variant="secondary"` (where applicable) plus a 2px start-edge **primary** bar (`border-l-2 border-l-primary`) |

**Touch sizes** on `Button` / `Toggle`: `touch` and `touch-icon` map to `min-h/min-w: var(--touch-target, 44px)`. Prefer these over repeating `min-h-11` at call sites. Docked panels omit `PanelFrame` titles when Dockview already shows the tab name; keep a toolbar-only row when actions are present. `PanelFrame` uses `--sidebar`; headers use `--card`.

Icon-only controls always have `aria-label`; tooltips are secondary and must not be the only way to discover the action.

Dev-only **Component Gallery**: `/?test=1&gallery=1` renders every installed primitive for on-device visual checks.
