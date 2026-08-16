# UI theming

Canonical tokens live in [`packages/ui/src/styles/globals.css`](../../packages/ui/src/styles/globals.css). Tailwind v4 maps them via `@theme inline`; components use semantic utilities (`bg-background`, `text-primary`, `bg-node-event`, `text-axis-x`, …) — not raw hex in app code.

Engine Settings **Appearance → Theme** (`system` | `light` | `dark`) is live. It toggles `html.dark`, which switches Neutral chrome surfaces. Default is **system**. A boot script in `apps/editor/index.html` reads `localStorage["babylonslate:engine-settings"]` plus `prefers-color-scheme` so the first paint matches on web. Capacitor Preferences hydrates after load (a brief flash is acceptable).

## Source scanning

Tailwind v4 detects sources relative to the CSS entry, which here lives in `packages/ui/src/styles`. Every workspace package that renders UI is therefore listed with `@source` in `globals.css`. Without those entries, a utility used *only* by a workspace component (dialog centering, for example) is never generated, and the failure is silent — the class is on the element with no rule behind it. Add an `@source` line when a new package starts rendering components.

## Theme source

Chrome is **Minimal Neutral** ([tweakcn](https://tweakcn.com/themes/cmho4nr9l000h04l1gu419ckw)): achromatic surfaces and ink `--primary`. Geist remains the UI font. Pin, node, success, and axis tokens stay chromatic so graph and gizmo meaning is independent of chrome. Edit `:root` and `.dark` in `globals.css` directly; do not re-import a tweakcn preset over those editor-function tokens.

`apps/editor/src/shell/design-tokens.test.ts` asserts ink `--primary`, Neutral backgrounds, `--chrome-tab-accent: var(--foreground)`, a chromatic `--axis-z` that is not `var(--primary)`, a darker light-mode `--pin-exec`, dark `--secondary`/`--muted` distinct from `--popover`, and Dockview tab colors plus 1px content-container outlines.

## Design philosophy

BabylonSlate is a game engine editor: chrome should be quiet, but **types and axes must be obvious**.

- **Primary is ink** (achromatic). Buttons, focus rings, and selection bars follow Neutral. Active tabs use `--chrome-tab-accent` → `var(--foreground)`.
- **Layered surfaces** differentiate chrome, side panels, and canvases.
- **Saturated pin/node and `--asset-*` colors are type cues** — not whole toolbars.
- **Axis and status accents** stay chromatic: X/Y/Z, Play (`--success`), destructive actions.

## Surface ladder

| Role | Token | Light | Dark |
| --- | --- | --- | --- |
| Viewport / graph canvas (always dark) | `--background` (dark) | n/a — canvases ignore light chrome | `oklch(0.145 0 0)` ≈ `#242424` |
| Side panels (`PanelFrame`) | `--sidebar` | `oklch(0.985 0 0)` | `oklch(0.205 0 0)` |
| Chrome / raised cards | `--card` | `oklch(1 0 0)` | `oklch(0.205 0 0)` |
| Headers / category bars | `--secondary` / `--muted` | `oklch(0.97 0 0)` | `oklch(0.32 0 0)` |
| Menus / viewport overlay | `--popover` | `oklch(1 0 0)` | `oklch(0.269 0 0)` |
| Hover / selection wash | `--accent` | `oklch(0.97 0 0)` | `oklch(0.371 0 0)` |

`--primary` is ink in both schemes: light `oklch(0.145 0 0)`, dark `oklch(0.985 0 0)`.

## Action and status tokens

| Role | Token | Notes |
| --- | --- | --- |
| Default actions / ink chrome | `--primary` | Achromatic Neutral ink |
| Focus / tab indicator | `--ring`, `--chrome-tab-accent` | Ring is muted gray; tab accent is `var(--foreground)` |
| Destructive | `--destructive` | Errors, unsaved dirty dot, axis X |
| Success / Play | `--success` | Positive status and the global Play control |

## Pin type colors

Unreal-like mapping. **oklch values** live in `:root` / `.dark` in `globals.css`. **Kind → token maps** live in [`packages/ui/src/lib/data-types.ts`](../../packages/ui/src/lib/data-types.ts) (`pinColorVar`, `PIN_COLOR_VAR`). `graph-ui` `pinCssVar` and editor-kit `TypeColorMark` read that module only — do not add a local color table. `--vector` aliases `--pin-vector`. Pins keep `border-card` so they separate from the canvas.

| Token | Kinds |
| --- | --- |
| `--pin-exec` | exec — light ink `oklch(0.145 0 0)`, dark near-white `oklch(0.95 0 0)` |
| `--pin-bool` | bool (saturated red) |
| `--pin-int` | int (cyan) |
| `--pin-float` | float (lime) |
| `--pin-string` | string (magenta) |
| `--pin-vector` | vec2 / vec3 / vec4 (gold) |
| `--pin-rotator` | rotator (violet) |
| `--pin-transform` | transform (orange) |
| `--pin-color` | color |
| `--pin-object` | objectRef (blue) |
| `--pin-class` | classRef (purple) — a class value, not a live instance |
| `--pin-actor` | actorRef (slightly cooler blue) |
| `--pin-struct` | structRef (teal) |
| `--pin-enum` | enumRef (olive) |
| `--pin-wildcard` | unbound resolvingWildcard / boxedWildcard / unknown (gray) |
| `--pin-delegate` | delegate (red) |

Arrays use the element color; maps use the value color. Wildcard pins recolor when a concrete type is wired in: resolving groups adopt that type for display (Array Get `out` turns float-green when `array<float>` lands on `array`), and boxed pins (Print) keep `boxedWildcard` in `__pins` but paint from the connected peer. Disconnecting with no remaining constraint restores `--pin-wildcard`. Other pin/node values are shared across schemes (colored node title bars already contrast on both chromes).

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
| `--node-dev-only-tape` | Development Only hazard-tape yellow (same in light and dark) |
| `--node-dev-only-stripe` | Development Only hazard-tape black stripe |
| `--node-editor-only-tape` | Editor Only hazard-tape cyan (same in light and dark) |
| `--node-editor-only-stripe` | Editor Only hazard-tape black stripe |
| `--node-bt-root` | Behaviour tree Root |
| `--node-bt-composite` | Behaviour tree Selector / Sequence / Parallel |
| `--node-bt-task` | Behaviour tree task leaves |
| `--node-bt-decorator` | Attached decorator row tint |
| `--node-bt-service` | Attached service row tint |

## Asset type colors

Content Browser, Outliner, catalogs, search, and document tabs resolve **icons** through `resolveTypeVisual` in [`packages/editor-kit/src/type-visuals.tsx`](../../packages/editor-kit/src/type-visuals.tsx). **Colors** come from DataTypes (`assetColorVar` / `--asset-*`). Change a hue in `globals.css`; change which family uses which token in `data-types.ts`. **Color is by kind; icon is by concrete type.** User-created classes walk `parentClass` ancestry and reuse the first engine icon (so `MyHero` uses Actor, `MyMesh` uses MeshComponent). Graph pin/node tokens stay on the same DataTypes maps. `TypeVisualIcon` passes Lucide `size` so the SVG `width`/`height` match the CSS box: **16** (`TYPE_VISUAL_ICON_CHROME_SIZE`) in chrome/lists, **40** (`TYPE_VISUAL_ICON_TILE_SIZE`) on Content Browser tiles. Tile glyphs also set Lucide `absoluteStrokeWidth` with design stroke **2** so the SVG `stroke-width` is `2 × 24 / 40` (1.2 viewBox units, 2 CSS px). Without that, viewBox-relative stroke 1.5–2 at 40px thickens to 2.5–3.3 px and dense icons (Film, Boxes, Grid) blob. UserInterface uses `PanelTop`, AnimationGraph `Workflow`, BehaviourTree `ListTree`; clip Animation keeps `Film`.

| Token | Kind | Distinct icons |
| --- | --- | --- |
| `--asset-scene` | Scene (yellow, Unreal Level) | Scene |
| `--asset-graph` | Graph / UserInterface / EditorUtilityInterface / BehaviourTree (cyan) | Graph, UserInterface (`PanelTop`), EditorUtilityInterface (widget glyph), BehaviourTree (`ListTree`) |
| `--asset-texture` | Texture, Sprite, Tileset, Tilemap (magenta) | Texture |
| `--asset-material` | Material, Shader (red) | Material |
| `--asset-model` | Model (orange) | Model |
| `--asset-audio` | Audio (green) | Audio |
| `--asset-font` | Font (sky) | Font |
| `--asset-animation` | Animation, AnimationGraph (blue) | Animation (`Film`), AnimationGraph (`Workflow`) |
| `--asset-class` | Class assets; Object / Actor / Widget identities (indigo) | Object (`BObject`, `GameInstance`, `FunctionLibrary`, `EditorFunctionLibrary`, `ActorComponent`), Actor, Widget (`WidgetComponent` until a Widget base class exists) |
| `--asset-script-type` | Enum, Structure, ScriptInterface (teal) | one icon each |
| `--asset-component` | Engine components in Details / Add Component (purple) | one icon per `ENGINE_COMPONENT_CLASS_IDS` |
| `--asset-folder` | Content Browser folders (yellow-green) | Folder glyph |

Place-actor shapes, lights, and cameras use the matching component **icon** with `--asset-class` (they spawn as Actors). Unknown types fall back to a file glyph and `--muted-foreground`.

Content Browser **asset** tiles mark the **thumbnail well only** with a 2px type-colored border (`typeColorThumbAccent`). The well is inset 2px (`p-0.5`) with `rounded-t-xl`, and the border uses `calc(var(--radius-xl) - 2px)` on the top corners so the outline sits inside the Card clip instead of being chopped. The well, `Card` chrome, and text panel stay `--card`. Glyphs still use the raw `--asset-*` token, Lucide `size={40}`, and `absoluteStrokeWidth` so stroke stays 2 CSS px. **Folder cards** are uncolored (`--card` well, muted folder glyph at the same Lucide size and absolute stroke). Selected tiles keep `border-primary` / `ring-primary`. `--asset-*` hues are at least 25° apart so mixed wells stay distinguishable. Enum / Structure / ScriptInterface keep `--asset-script-type` on tiles; Details type columns use **pin** colors via `PinTypePicker`.

## Graph sizing tokens

| Token | Value | Use |
| --- | --- | --- |
| `--touch-target` | `44px` | Graph pin rows and remaining large hit boxes |
| `--chrome-row` | `28px` | Editor chrome, panel headers, property rows, catalog item rows |
| `--graph-pin-size` | `22px` | Visual pin diamond / circle / list |
| `--graph-edge-exec` | `5px` | Exec wire stroke |
| `--graph-edge-data` | `4px` | Data wire stroke |

Dockview tab strips: **18px** fine pointer, **26px** coarse (`apps/editor/src/shell/dockview-theme.css`). Tab strips use `--card`. Tabs use `--dv-tab-margin: 0 2px` so they have a slight horizontal gap without changing strip height. Tab labels use `--foreground` / `--muted-foreground` (not vendor white) so light chrome stays readable. Each `.dv-content-container` has a 1px inset outline from `color-mix(in oklch, var(--foreground) 18%, transparent)` so panel content bounds stay visible in both schemes without recoloring the tab strip. Tree rows are 28px (`--chrome-row`).

## Axis colors

Vector scrub labels: `--axis-x` → `--destructive`, `--axis-y` → `--success`, `--axis-z` is an independent blue (`oklch(0.50 0.14 250)` light / `oklch(0.62 0.14 250)` dark) — not `var(--primary)`, because primary is ink (`text-axis-x` / `y` / `z`). Scene/Prefab transform gizmos in `@babylonslate/render` cannot read CSS; they hardcode matching `Color3`s in `GIZMO_AXIS_COLORS` (`x` 0.86/0.24/0.22, `y` 0.22/0.68/0.38, `z` 0.28/0.48/0.86). Uniform scale uses unlit `GIZMO_UNIFORM_COLOR` (`0.82/0.84/0.88`) on Babylon’s center octahedron. Keep those in sync when axis tokens change.

## Other extension tokens

| Token | Purpose |
| --- | --- |
| `--chrome-row` | Compact chrome / panel header height (28px) |
| `--chrome-tab-active` | Active document tab fill (`var(--card)`) |
| `--chrome-tab-accent` | Tab indicator (`var(--foreground)`) |

## Viewport and graph canvas

Scene, Prefab, and graph **canvases stay dark** regardless of Appearance → Theme. Chrome still follows `html.dark`.

`packages/render` sets Babylon `scene.clearColor` from `editorClearColor("dark")` via `EDITOR_CANVAS_COLOR_SCHEME`. `editorClearColor("light")` remains for tests. Editor and Prefab viewports pass `colorScheme: EDITOR_CANVAS_COLOR_SCHEME` into `createEngine` and do not follow the resolved chrome scheme.

`GraphEditor` takes `colorMode` (`"light" | "dark"`). The graph panel always passes `"dark"` and scopes dark graph tokens on the canvas wrapper so a light `html` does not wash nodes or wires. Per-edge `style.stroke` from the source pin color wins; the canvas must not force `--xy-edge-stroke` to `--pin-exec`. XYFlow chrome uses `--background` / `--border` under that dark scope.

Toolbar `DropdownMenu`s (Debug, Settings, Add) and picker `SearchDropdown`s default to `modal={false}` so they do not paint a full-viewport `position: fixed` backdrop over the Babylon canvas. On iPad WKWebView that overlay composites as a full black page. Dialog / AlertDialog stay modal. Do not use full-width bottom `Sheet`s for pick lists or Play chrome.

`DropdownMenuLabel` is a Base UI `Menu.GroupLabel` and must sit inside `DropdownMenuGroup`. Opening Debug without that group throws (production error #31) and unmounts the editor to a black screen.

Opening an **old Scene** used to do the same: Details read missing additive `settings.grid` / `environmentColor` and React emptied `#root`. Editor load now runs `normalizeScene` (see [scene-editing.md](scene-editing.md)). Each document tab is wrapped in `WorkspaceErrorBoundary` so a later panel throw shows an inline Alert instead of a black page.

`#root` uses `isolation: isolate` so Base UI portals stack above the app instead of fighting chrome `z-index`. `body` is `position: relative` so iOS 26+ visual-viewport backdrops still cover the shell.

## UI composition

Editor chrome and panels compose from `@babylonslate/ui` (shadcn) and `@babylonslate/editor-kit` (panel frame, toolbar strip). Do not add raw styled `<input>`, `<select>`, or `<button>` in `apps/editor/src` — use Field + shadcn primitives. Inventory: [components.md](components.md).

**Action vs pressed:**

| Treatment | Use |
| --- | --- |
| `Button variant="outline"` | Visible actions (chrome Save All / Undo, panel Add/Remove, catalog primary controls). Also the **trigger** that opens an irreversible confirm (Content Browser **Delete (N)**, plugin list Delete), and Close Project. |
| `Button variant="ghost"` | Tabs, menu items, icon-only close |
| `Button variant="destructive"` | Solid filled `--destructive` confirm on a danger `AlertDialog` — asset, folder, and plugin delete. Not a 10% tint. |
| `AlertDialogContent variant="destructive"` | Irreversible file-destroying confirms: red ring, red media well, red title, `sm:max-w-md` |
| `Toggle` / `ToggleGroup` `variant="outline"` | Exclusive tools; selected item uses **accent fill + primary border** + `aria-pressed` (not a near-invisible secondary wash) |
| Catalog / folder / outliner selected | `variant="secondary"` (where applicable) plus a 2px start-edge **primary** bar (`border-l-2 border-l-primary`) |

**Touch sizes** on `Button` / `Toggle`: `touch` and `touch-icon` map to `min-h/min-w: var(--touch-target, 44px)`. Prefer these over repeating `min-h-11` at call sites. Docked panels omit `PanelFrame` titles when Dockview already shows the tab name; keep a toolbar-only row when actions are present. `PanelFrame` uses `--sidebar`; headers use `--card`.

Icon-only controls always have `aria-label`; tooltips are secondary and must not be the only way to discover the action. Chrome **Save All** is disabled when the project is clean; a `bg-destructive` dot (`data-testid="save-all-dirty"`) marks unsaved documents.

Dev-only **Component Gallery**: `/?test=1&gallery=1` renders every installed primitive for on-device visual checks.

## Brand assets

Source artwork lives in [`engine-logos/`](../../engine-logos/). It is human-authored. Agents must never AI-generate replacements, icons, videos, 3D models, or similar media ([no-ai-artwork.mdc](../../.cursor/rules/no-ai-artwork.mdc)).

| File | Ink | Use |
| --- | --- | --- |
| `SlateLogoDark.png` / `SlateLogoLight.png` | Dark (black) / light (white) wordmark | Homepage header (`h-8` / 2rem), docs home hero |
| `SlateIconDark.png` / `SlateIconLight.png` | Dark / light mark | Docs nav, favicon source |

`*Dark` is dark ink for light chrome; `*Light` is light ink for dark chrome. Served copies must stay byte-identical in `apps/editor/public/branding/` and `apps/docs/public/branding/`.

Favicon is a theme-aware SVG (`prefers-color-scheme`) plus `favicon.ico` and `apple-touch-icon.png` in each app's `public/`. The editor homepage swaps wordmarks with `html.dark` (`dark:hidden` / `dark:block`), not `prefers-color-scheme`, so Engine Settings Appearance wins.
