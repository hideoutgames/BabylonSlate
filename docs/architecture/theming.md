# UI theming

Canonical tokens live in [`packages/ui/src/styles/globals.css`](../../packages/ui/src/styles/globals.css). Tailwind v4 maps them via `@theme inline`; components use semantic utilities (`bg-background`, `text-primary`, `bg-node-event`, `text-axis-x`, …) — not raw hex in app code.

Engine Settings **Appearance → Theme** (`system` | `light` | `dark`) is shared by the launcher and editor. The launcher toggle saves an explicit light or dark choice to the same `appearance.theme` setting; choosing System in Engine Settings makes both follow the OS. `EditorThemeProvider` resolves the preference and toggles `html.dark`, which switches Neutral chrome surfaces. Default is **system**. A boot script in `apps/editor/index.html` reads `localStorage["babylonslate:engine-settings"]` plus `prefers-color-scheme`; the initial splash inherits that resolved scheme. Native settings hydrate after load (a brief flash is acceptable).

## Source scanning

Tailwind v4 detects sources relative to the CSS entry, which here lives in `packages/ui/src/styles`. Every workspace package that renders UI is therefore listed with `@source` in `globals.css`. Without those entries, a utility used *only* by a workspace component (dialog centering, for example) is never generated, and the failure is silent — the class is on the element with no rule behind it. Add an `@source` line when a new package starts rendering components.

## Theme source

Chrome is **Minimal Neutral** ([tweakcn](https://tweakcn.com/themes/cmho4nr9l000h04l1gu419ckw)): achromatic surfaces and ink `--primary`. Geist remains the UI font. Pin, node, success, and axis tokens stay chromatic so graph and gizmo meaning is independent of chrome. Edit `:root` and `.dark` in `globals.css` directly; do not re-import a tweakcn preset over those editor-function tokens.

`apps/editor/src/shell/design-tokens.test.ts` asserts ink `--primary`, Neutral backgrounds, `--chrome-tab-accent: var(--foreground)`, a chromatic `--axis-z` that is not `var(--primary)`, a darker light-mode `--pin-exec`, dark `--secondary`/`--muted` distinct from `--popover`, and Dockview tab colors plus 1px content-container outlines.

## Safe-area insets

`globals.css` owns the four safe-area tokens: `--safe-top`, `--safe-right`, `--safe-bottom`, and `--safe-left`. They resolve the corresponding `env(safe-area-inset-*, 0px)` values, keeping web, Electron, and jsdom at zero. Surfaces consume these tokens and never call `env()` directly.

- The editor and Homepage roots use `.safe-frame` for left, right, and bottom insets.
- Installed phone apps reserve at least 2rem at the bottom when the platform reports a zero home-indicator inset; larger reported insets still win. Browser tabs and tablet/desktop layouts use their reported insets without this minimum.
- `--safe-bottom` is a registered CSS length, so JavaScript-positioned menus read the same resolved pixels as CSS layout, including the installed-phone minimum.
- The body owns the dynamic viewport height; Homepage and editor fill it without inherited viewport minimums. Body/root clipping prevents extra shell scroll containers, while orientation recovery resets retained document offsets during the following second of viewport resize events. Panel scrolling and input focus are preserved.
- Full-height Homepage chrome also uses `.safe-frame-top`; editor chrome consumes the top inset in its title bar.
- The editor chrome shell owns the top inset while preserving the interactive row height.
- Fixed context menus and Play/Preview Build overlay chrome consume the tokens themselves; their canvases and iframe remain edge-to-edge.
- The visible native iPad status bar follows the resolved editor theme through the VFS status-bar-style port.

## Adaptive editor layout

- iPad and desktop retain the compact 28px global bars, small Primary actions, pinned Content Browser/Scene tabs, and resizable dock layout. Dock tabs retain their 18px fine-pointer / 26px coarse-pointer strips; semantic borders and surfaces separate tools from content.
- Phone layout activates below 768px wide, or at 500px tall or less with a coarse pointer. The global bars use 44px targets; Content Browser and Open Documents provide navigation, with secondary commands under More Tools.
- Phone Dockview shows one window with a bottom **Window** picker. Window switching uses Dockview visibility and keeps the tablet layout separate; returning to a larger window restores its splits. Focus is unnecessary in this mode.
- Phone Outliner and My Class trees use 44px rows and actions; tablet and desktop retain their compact 28px rows.
- Content Browser keeps its tile appearance. Folders open in a Sheet, selected items have an explicit **Open** action, and **New Asset** separates type selection from details. Catalog dialogs replace their category sidebar with a picker.
- Dialogs and sheets fit the dynamic viewport and safe areas. Menu rows expand for coarse pointers. Feedback uses color and restrained fades, without button movement; reduced-motion preferences are respected.
- These adaptations apply [Apple HIG layout](https://developer.apple.com/design/human-interface-guidelines/layout), [button](https://developer.apple.com/design/human-interface-guidelines/buttons), and [toolbar](https://developer.apple.com/design/human-interface-guidelines/toolbars) guidance while retaining professional editor density. Device input and safe areas determine presentation; the UI does not depend on an Apple-only host.

## Modal workflows and settings

- Large catalogs, New Asset, and multiline editors use `editor-dialog-large`: the available viewport minus safe areas and an 8-16px gap per edge, without a fixed desktop size cap. Headers and actions stay outside their scrolling bodies. Small prompts remain content-sized.
- Modal actions and editable fields keep compact desktop defaults. Coarse pointers receive non-overlapping 44px targets, including search Clear, and readable text-entry sizing. Footer actions wrap in their DOM order.
- New Asset uses grouped type rows and a wider working details pane. Phones retain Type, Next, Details, and Back without discarding the draft. Step changes focus the content rather than opening the touch keyboard. Type and parent choices support arrow navigation; Enter in Name creates only when the draft is valid and idle.
- Project and Engine Settings keep their immediate-save behavior. Done closes the dialog; it does not apply a draft. Scalar controls align with their labels and stack on narrow phones; lists retain the full content width.
- General includes editable Project Version (`metadata.version`) alongside project behavior; it omits static project-name and touch-target readouts. Settings copy explains consequences only; implementation details and repeated label descriptions are omitted. Focus explains retained windows once, and unmatched settings searches show an empty state.
- Delete confirms grow with their content up to the large-dialog bounds. A compact icon-and-text header sits above flat lists with aligned headings. Incoming references use a subtly tinted column showing type, asset path, and affected targets; it stacks below selected items on narrow screens and is omitted when empty. Both lists share a contained touch-scroll region. Headers and Cancel/Delete remain visible.
- Shared sliders retain Base UI track sizing and provide named range inputs with 44px thumb hit areas. Settings retain the shared Switch width and reserve its expanded touch area; they never override the track width.
- Picker navigation supports arrows and Enter with the active result kept visible and mounted. Touch opening avoids text autofocus; keyboard opening starts in search. Existing Base UI dismissal and return-focus semantics remain in place.

## Design philosophy

BabylonSlate is a game engine editor: chrome should be quiet, but **types and axes must be obvious**.

- **Primary is ink** (achromatic). Buttons and focus rings follow Neutral. Selected navigation/tree rows and active tabs use a whole-surface fill; do not add curved edge stripes or inset underline highlights.
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

Dark modal boundaries use opaque neutral `--border` / `--sidebar-border` (`oklch(0.43 0 0)`) and stronger `--input` (`oklch(0.50 0 0)`). Dialog outlines use the border token; settings fields have readable row dividers. `--list-stripe` supplies a slightly darker alternate background in both themes for catalog and picker rows. Add Node assigns stripes by item order before virtualization, excluding category headers.

## Action and status tokens

| Role | Token | Notes |
| --- | --- | --- |
| Default actions / ink chrome | `--primary` | Achromatic Neutral ink |
| Focus / docking indicator | `--ring`, `--chrome-tab-accent` | Ring is muted gray; docking targets use foreground ink |
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
| `--pin-quat` | quaternion (magenta-violet) |
| `--pin-transform` | transform (orange) |
| `--pin-color` | color |
| `--pin-object` | objectRef (blue) |
| `--pin-class` | classRef (purple) — a class value, not a live instance |
| `--pin-actor` | actorRef (slightly cooler blue) |
| `--pin-struct` | structRef (indigo, same oklch as Structure tiles `--asset-class`) |
| `--pin-enum` | enumRef (teal, same oklch as Enum tiles `--asset-script-type`) |
| `--pin-wildcard` | unbound resolvingWildcard / boxedWildcard / unknown (gray) |
| `--pin-delegate` | delegate (red) |

Arrays use the element color; maps use the value color. Wildcard pins recolor when a concrete type is wired in: resolving groups adopt that type for display (Array Get `out` turns float-green when `array<float>` lands on `array`), and boxed pins (Print) keep `boxedWildcard` in `__pins` but paint from the connected peer. Disconnecting with no remaining constraint restores `--pin-wildcard`. Other pin/node values are shared across schemes (colored node title bars already contrast on both chromes).

## Node role colors

Title-bar fills for Blueprint-like nodes:

| Token | Role |
| --- | --- |
| `--node-event` | `flow.event.*` / titles starting `Event` (not Call Parent) |
| `--node-call-parent` | `flow.event.callParent` (brown title bar) |
| `--node-function` | default impure calls |
| `--node-pure` | `pure` (math, getters) |
| `--node-flow` | flow control (Branch, Sequence) |
| `--node-variable` | Get Variable / Validated Get |
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

Content Browser, Outliner, catalogs, search, and document tabs resolve **icons** through `resolveTypeVisual` in [`packages/editor-kit/src/type-visuals.tsx`](../../packages/editor-kit/src/type-visuals.tsx). **Colors** come from DataTypes (`assetColorVar` / `--asset-*`). Change a hue in `globals.css`; change which family uses which token in `data-types.ts`. **Color is by kind; icon is by concrete type.** User-created classes walk `parentClass` ancestry and reuse the first engine icon (so `MyHero` uses Actor, `MyMesh` uses MeshComponent), including the New Asset Parent Class tree. Graph pin/node tokens stay on the same DataTypes maps. `TypeVisualIcon` passes Lucide `size` so the SVG `width`/`height` match the CSS box: **16** (`TYPE_VISUAL_ICON_CHROME_SIZE`) in chrome/lists, **40** (`TYPE_VISUAL_ICON_TILE_SIZE`) on Content Browser tiles. Tile glyphs also set Lucide `absoluteStrokeWidth` with design stroke **2** so the SVG `stroke-width` is `2 × 24 / 40` (1.2 viewBox units, 2 CSS px). Without that, viewBox-relative stroke 1.5–2 at 40px thickens to 2.5–3.3 px and dense icons (Film, Boxes, Grid) blob. AnimationGraph uses `Workflow`, BehaviourTree `ListTree`; clip Animation keeps `Film`.

| Token | Kind | Distinct icons |
| --- | --- | --- |
| `--asset-scene` | Scene, AudioMixer (yellow, Unreal Level) | Scene, AudioMixer (`Volume2`) |
| `--asset-graph` | Graph (cyan) | Graph |
| `--asset-texture` | Texture, Sprite, Tileset, Tilemap (magenta) | Texture |
| `--asset-material` | Material, Material Function, Shader (green, former Audio) | Material |
| `--asset-model` | Model (orange) | Model |
| `--asset-audio` | unused by a Content Browser type (lime; kept so asset hues stay ≥25° apart) | — |
| `--asset-font` | Font (sky) | Font |
| `--asset-animation` | Animation, AnimationGraph, Class / Object / Actor / ScriptInterface / BehaviourTree, SoundAttenuation, imported Audio (blue) | Animation (`Film`), AnimationGraph (`Workflow`), Object, Actor, Class, ScriptInterface (`Plug`), BehaviourTree (`ListTree`), SoundAttenuation (`Volume2`), Audio (`Volume2`) |
| `--asset-class` | Blackboard, Structure, AudioChannel (indigo; former Class hue) | Blackboard (`List`), Structure (`Braces`), AudioChannel (`Volume2`) |
| `--asset-script-type` | Enum, PluginSettings (teal) | Enum, PluginSettings (`Puzzle`) |
| `--asset-component` | Engine components in Details / Add Component (purple) | one icon per `ENGINE_COMPONENT_CLASS_IDS` |
| `--asset-folder` | Content Browser folders (gold / yellow) | Folder glyph |

Place-actor shapes, lights, and cameras use the matching component **icon** with `--asset-animation` (they spawn as Actors; same token as Class / Object). Unknown types fall back to a file glyph and `--muted-foreground`.

Content Browser **asset** tiles mark the **thumbnail well only** with a 2px type-colored border (`typeColorThumbAccent`). The accent box is `absolute inset-0.5` (2px from the square well) so the bottom stroke is not clipped by padding + `height: 100%`. Top corners use `calc(var(--radius-xl) - 2px)` so the outline sits inside the Card clip instead of being chopped. New Asset uses compact type-icon rows rather than thumbnail wells. The well, `Card` chrome, and text panel stay `--card`. Glyphs still use the raw `--asset-*` token, Lucide `size={40}`, and `absoluteStrokeWidth` so stroke stays 2 CSS px. **Folder cards** are uncolored (`--card` well, muted folder glyph at the same Lucide size and absolute stroke). Selected tiles keep `border-primary` / `ring-primary`. `--asset-*` hues are at least 25° apart so mixed wells stay distinguishable. Enum keeps `--asset-script-type` on tiles; Structure, Blackboard, and AudioChannel use `--asset-class`; ScriptInterface, SoundAttenuation, and imported Audio share `--asset-animation` with Class; AudioMixer shares `--asset-scene`. Details type columns use **pin** colors via `PinTypePicker`.

## Graph sizing tokens

| Token | Value | Use |
| --- | --- | --- |
| `--touch-target` | `44px` | Graph pin rows and remaining large hit boxes |
| `--chrome-row` | `28px` | Editor chrome, panel headers, property rows, catalog item rows |
| `--graph-pin-size` | `22px` | Visual pin diamond / circle / list / map |
| `--graph-pin-default-max-width` | `12rem` | Truncation cap for on-node literal default and type-name fields |
| `--graph-edge-exec` | `5px` | Exec wire stroke |
| `--graph-edge-data` | `4px` | Data wire stroke |

Default Blueprint shells use Tailwind `w-max min-w-80` and grow with `whitespace-nowrap` titles and pin names (`shrink-0`, no `min-w-0` pin columns) plus a `gap-6` gutter between in/out labels. Compact BT nodes use `min-w-56`. Get Variable uses a `w-max` pill (`rounded-full`, `min-h-14`, `px-4`, `gap-4`, no `min-w-80`) outlined in the value pin color. Title bars are `text-base`. Pin rows stay `--touch-target` (44px). Text pin defaults (string, numeric, type name) use `w-fit` and truncate at `--graph-pin-default-max-width`. `graph-editor.css` `[data-pin-default-field]` sets `min-width: min(12rem, max-content)` so truncate does not collapse the field, and unbounded `min-width: fit-content` cannot defeat the 12rem cap. Pin rows are `w-full min-w-max` so every row stretches to the widest pin row and `justify-between` keeps Then on the right. `[data-pin-row]` in `graph-editor.css` matches that (`width: 100%`; `min-width: max-content`). XYFlow wrappers in `.graph-editor-canvas` use `width: max-content` so a previous measured px width does not clip that chrome.

Project Settings **Input** reuses pin tokens for device accents rather than new CSS variables: key `--pin-string`, mouse `--pin-object`, pointer `--pin-wildcard`, gamepad button `--pin-bool`, gamepad axis `--pin-vector`, touch `--pin-float`. Action/axis section legends use bool / vector. 2D binding X/Y toggles use `text-axis-x` / `text-axis-y`.

Dockview tab strips: **18px** tall / **56px** min-width on fine pointers, **26px** tall / **64px** min-width on coarse (`apps/editor/src/shell/dockview-theme.css`). Tab strips use `--card`. Tabs use `--dv-tab-margin: 0 2px` so they have a slight horizontal gap without changing strip height. Tab labels use `--foreground` / `--muted-foreground` (not vendor white) so light chrome stays readable. Each `.dv-content-container` has a 1px inset outline from `--border` so panel content bounds stay visible in both schemes without recoloring the tab strip. Tree rows are 28px (`--chrome-row`).

The chrome document tab strip keeps pinned Content Browser and the open Scene tab (when present) outside the scroller (`.editor-chrome-tabs-pinned` inside `.editor-chrome-tabs`, `overflow: hidden`). Other document tabs pan in `.editor-chrome-tabs-scroll` (`overflow-x: auto`) when they overflow and hide native and iOS overlay scrollbars (`scrollbar-width: none` plus `::-webkit-scrollbar { display: none }`). The Scene pin is closable and is not drag-reorderable.

## Axis colors

Vector scrub labels: `--axis-x` → `--destructive`, `--axis-y` → `--success`, `--axis-z` is an independent blue (`oklch(0.50 0.14 250)` light / `oklch(0.62 0.14 250)` dark) — not `var(--primary)`, because primary is ink (`text-axis-x` / `y` / `z`). Scene/Prefab transform gizmos in `@babylonslate/render` cannot read CSS; they hardcode matching `Color3`s in `GIZMO_AXIS_COLORS` (`x` 0.86/0.24/0.22, `y` 0.22/0.68/0.38, `z` 0.28/0.48/0.86). Uniform scale uses unlit `GIZMO_UNIFORM_COLOR` (`0.82/0.84/0.88`) on Babylon’s center octahedron. Keep those in sync when axis tokens change.

## Other extension tokens

Trace inspection uses `--trace-selected` (vibrant orange in both schemes), `--trace-script` and `--trace-physics`. Orange selection and the full-height cursor remain independent of destructive budget markers. Current-tick log entries use a subtle orange whole-row fill without an edge stripe. These tokens do not recolor the neutral focus ring or primary controls.

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
| Catalog / folder / outliner selected | Whole-row `secondary` / `accent` fill with accessible selected/current state; no start-edge bar |

Dialog footer actions, including AlertDialog Save / Discard / Cancel, share the same 44px minimum on coarse pointers and preserve compact desktop sizing.

**Touch sizes** on `Button` / `Toggle`: `touch` and `touch-icon` map to `min-h/min-w: var(--touch-target, 44px)`. Prefer these over repeating `min-h-11` at call sites. Docked panels omit `PanelFrame` titles when Dockview already shows the tab name; keep a toolbar-only row when actions are present. `PanelFrame` uses `--sidebar`; headers use `--card`.

Icon-only controls always have `aria-label`; tooltips are secondary and must not be the only way to discover the action. Chrome **Save All** is disabled when the project is clean; a `bg-destructive` dot (`data-testid="save-all-dirty"`) marks unsaved documents.

Dev-only **Component Gallery**: `/?test=1&gallery=1` renders every installed primitive for on-device visual checks.

## Brand assets

Source artwork lives in [`engine-logos/`](../../engine-logos/). It is human-authored. Agents must never AI-generate replacements, icons, videos, 3D models, or similar media ([no-ai-artwork.md](../../.agents/rules/no-ai-artwork.md)).

| File | Ink | Use |
| --- | --- | --- |
| `SlateLogoDark.png` / `SlateLogoLight.png` | Dark (black) / light (white) wordmark | Docs home hero |
| `SlateIconDark.png` / `SlateIconLight.png` | Dark / light mark | Homepage rail (`BrandIcon`), docs nav, favicon source |

`*Dark` is dark ink for light chrome; `*Light` is light ink for dark chrome. Served copies must stay byte-identical in `apps/editor/public/branding/` and `apps/docs/public/branding/`.

Launcher list badges use a subtle 2px lift on fine-pointer hover and remain stationary on touch devices.

Launcher touch interactions:

- Project and template cards give immediate color feedback on contact. Native scrolling, cancelled/interrupted contacts, and touches used to stop momentum do not activate a card; a fresh tap or keyboard activation still works. Long-press menus retain the 500ms threshold.
- Galleries commit the active page after scrolling settles, accumulate rapid page requests, and retain the current project across layout/viewport changes. Only the visible page and its neighbors mount card content.
- Touch-capable hybrid devices receive the same touch targets as coarse pointers. Mouse hover remains available when using the mouse; touch does not leave badge hover motion behind.
- The creator follows the visual viewport when the software keyboard changes its height, preserves drafts across template steps, and avoids automatic keyboard opening on touch-capable devices. Pinch zoom does not resize the form.
- The shared overscroll fallback checks the latest movement direction and reads styles once per ancestor. The editor's three-finger editing suppression is installed only on editor routes.
- Loading keeps its two-second minimum and 600ms editor readiness hold. Input unlocks when the opacity fade completes (650ms fallback), or immediately after readiness with reduced motion.

Favicon is a theme-aware SVG (`prefers-color-scheme`) plus `favicon.ico` and `apple-touch-icon.png` in each app's public assets. The launcher uses the existing icon and text brand **Slate**, with cool graphite and light silver palettes scoped under `.homepage-theme`, selected by the shared engine appearance setting. The former `slate:launcher-scheme` preference is no longer used. Portaled composer/profile content shares the launcher palette. Profile opens an avatar dropdown; configured web accounts use Clerk UserButton, while guest/native menus reuse DropdownMenu. The CSS is imported as text and mounted only with Home; editor tokens and density remain independent.

Projects and Templates occupy separate viewport-sized views with native horizontal pagination. Project view density persists independently as large cards, eight-card (4 by 2) desktop pages with fixed column slots on partially filled pages, or a list. Project pictures stay on the badge; the browser and creator share a full-width shaded back and raised face, with depth proportional to badge size; Lucide glyphs render without forced parent 3D layers. Static inverted dot vignettes and subtle badge-colored glows sit behind the badges. Template cards reserve an image well for future catalog images. Search, Most Used / Name ordering, and ZIP import appear in both template pickers. The creator Options disclosure uses only its label and plus/minus indicator, with no border or fill. The create flow transitions from template selection to name/appearance; edit opens the identity step directly. Uploaded pictures use bounded local raster thumbnails, and vivid preset colors have named, focusable circular choices alongside the picture upload action. Coarse pointers receive 48px targets and avoid automatic keyboard opening. Project context menus support right-click, long-press, and Shift+F10; after Escape restores focus, Enter can open the project immediately without being consumed by the touch-release guard.

The desktop empty state loads `homepage-sculpture.tsx` and its Blender-created `public/launcher/slate-object.glb` on demand. The model cuts the existing Slate logo silhouette through only the front slab in Blender, preserving the source image's 289:371 aspect ratio; it has no printed logo texture. The two rear slabs are simple beveled meshes; the optimized GLB is about 290 KB with 4,706 source mesh vertices. This isolated Three.js renderer has a capped pixel ratio and 30 fps loop, pauses on document visibility changes and behind loading, launcher dialogs, profile menus, or Templates, renders statically with reduced motion, and disposes its GPU resources on unmount. Desktop shows no decorative placeholder while the model loads. Phone and short-landscape layouts use the existing mark without loading the 3D module. Switching Projects and Templates retains the canvas while pausing hidden rendering. A matching HTML/React splash card uses lightweight animated slab shapes, a shadow over an opaque black background, the engine or project name, release build version (Development build for local previews), and real loading status. It has a two-second minimum and waits for the launcher assets; project launch keeps the cover through editor route setup and fades it away. The cover is portaled above the composer and unmounts its stylesheet afterward. The model was created for the explicitly requested Blender design iteration; it does not change the general artwork policy.
