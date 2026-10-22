# Theming

Editor and launcher theme tokens, semantic color families, density, canvas and overlay rules agents must follow when touching Haptic UI.

## Token location

- Canonical tokens: [`packages/ui/src/styles/tokens.css`](../../../packages/ui/src/styles/tokens.css) (`:root` light, `.dark` dark), imported by `globals.css`. Tailwind v4 maps them through `@theme inline`. Keep `:root` and `.dark` as top-level blocks: the docs build re-roots them on its node previews.
- Use semantic utilities only (`bg-background`, `bg-sidebar`, `text-primary`, `bg-node-event`, `text-axis-x`, …). No raw hex or ad-hoc oklch in app code (theme color data in `editor-themes.ts` is the exception), and no preset imported over the editor-function tokens.
- Kind → token maps live in [`packages/ui/src/lib/data-types.ts`](../../../packages/ui/src/lib/data-types.ts) (`pinColorVar`, `PIN_COLOR_VAR`, `assetColorVar`, `PARTICLE_STAGE_ROLE`, `typeColorThumbAccent`). `graph-ui` `pinCssVar` and editor-kit `TypeColorMark` read that module; never add a local color table. Change a hue in `tokens.css`; change which kind uses which token in `data-types.ts`.
- Icons resolve through `resolveTypeVisual` in [`packages/editor-kit/src/type-visuals.tsx`](../../../packages/editor-kit/src/type-visuals.tsx). Color is by kind, icon by concrete type; user classes reuse their first engine ancestor's icon. Icon sizes: 16 in chrome/lists, 40 on tiles with `absoluteStrokeWidth`.
- Tailwind scans sources relative to the CSS entry, so `globals.css` lists each UI-rendering package with `@source`. Add an `@source` line when a new package renders components, or its utilities silently produce no CSS.
- Dockview theming: [`apps/editor/src/shell/dockview-theme.css`](../../../apps/editor/src/shell/dockview-theme.css). The overflow popover mounts outside `.dockview-theme-babylonslate` and is styled from editor tokens directly.

## Appearance

- Dark only: `EditorThemeProvider` always applies `html.dark`, and a boot script in [`apps/editor/index.html`](../../../apps/editor/index.html) sets it before load.
- Editor themes ([`editor-themes.ts`](../../../apps/editor/src/lib/editor-themes.ts)) override the `.dark` token values. App settings hold `editorTheme` (selected id) and `customEditorThemes` (`{ id, name, colors }`, colors only where they differ from Default, as `#rrggbb` keyed by token name without `--`). Built-ins (`BUILT_IN_EDITOR_THEMES`, currently Default) are read-only: an edit while one is selected forks a custom theme inside the settings mutation. Default's hex table mirrors `tokens.css` and a test checks it; add a token to the table and a Style group together. `EditorThemeProvider` writes overrides into one `<style>` element as `:root:root, :root .dark`, so nested `.dark` scopes (React Flow canvases) follow the theme. Theme files are JSON `{ format: "haptic-editor-theme", version, name, colors }`; import ignores unknown keys and fills missing ones from Default. UI: **Manage Account > Application > Theme** ([`homepage-theme-settings.tsx`](../../../apps/editor/src/components/homepage-theme-settings.tsx)); its preview ([`editor-theme-preview.tsx`](../../../apps/editor/src/components/editor-theme-preview.tsx)) renders a static, inert Class document from the editor's own parts (chrome CSS classes, a real Dockview layout, `TreeView`, `GraphEditor` with the Class template graph, `PropertyGrid`) at 1440×900 and scales it down only after React Flow has measured the pins (they are measured with `getBoundingClientRect`, which includes transforms); keep it in step when the Class editor's layout changes.
- Haptic warm-black chrome (haptic.no): `--primary` is white ink; buttons follow it and focus rings are amber. `--brand-red` / `--brand-amber` and `--brand-fringe` carry the chromatic-fringe accent, used only under the active document tab. Pin, node, asset, axis, status and Play tokens stay chromatic so meaning is independent of chrome.
- Type: Onest (`packages/ui/src/styles/onest.css`), with vertical metric overrides that centre capitals in compact rows.
- Surface ladder: `--background` (app frame) → `--sidebar` (PanelFrame) → `--card` → `--panel-header` → `--popover` (menus, dialogs, floating tools); `--control` for inputs, `--accent` for hover/selection. `--radius` is 8px.
- No automated contrast test exists; validate with screenshots and interaction review.

## Density and touch

- Preserve compact desktop density: `--chrome-row` 28px rows, small Primary buttons, 26px Dockview tab strips, 28px global bars. Imported design guidance must not enlarge these.
- Coarse pointers get 44px targets via `--touch-target` and the `Button` / `Toggle` `touch` / `touch-icon` sizes; prefer those over call-site `min-h-11`. Graph pin rows stay 44px everywhere.
- Phone layout: below 768px wide, or ≤ 500px tall with a coarse pointer ([`use-platform-layout.ts`](../../../apps/editor/src/shell/use-platform-layout.ts)). One Dockview window with a bottom Window picker; 44px bars and rows.
- Safe areas come from `--safe-top/right/bottom/left` in `globals.css`. Surfaces consume the tokens; canvases and the Preview iframe stay edge-to-edge. The launcher also reaches the bottom edge: only its sidebar account row, gallery end and build label pad by `--safe-bottom`.

## Canvas and overlay rules

- Scene, Prefab and graph canvases stay dark regardless of theme. Viewports pass `colorScheme: EDITOR_CANVAS_COLOR_SCHEME` ([`editor-clear-color.ts`](../../../packages/render/src/editor-clear-color.ts)) and never follow the chrome scheme; `GraphEditor` always receives `colorMode="dark"` with dark tokens scoped to the canvas.
- Per-edge `style.stroke` from the source pin wins; do not force `--xy-edge-stroke`.
- Toolbar `DropdownMenu`s and `SearchDropdown`s default to `modal={false}`. A modal backdrop composites as a full black page over the Babylon canvas on iPad WKWebView. Dialog / AlertDialog stay modal.
- Do not use full-width bottom `Sheet`s for pick lists or Play chrome.
- `DropdownMenuLabel` (Base UI `Menu.GroupLabel`) must sit inside `DropdownMenuGroup`; otherwise opening the menu throws and blanks the editor.
- Each document tab renders inside `WorkspaceErrorBoundary` so a panel throw shows an inline Alert, not a black page. `#root` uses `isolation: isolate` so portals stack above chrome.

## Composition

- Compose chrome from `@babylonslate/ui` (shadcn) and `@babylonslate/editor-kit`. No raw styled `<input>`, `<select>` or `<button>` in `apps/editor/src`.
- `outline` buttons for visible actions and for the trigger of an irreversible confirm; `ghost` for tabs, menu items and icon-only close; solid `destructive` only for the confirm inside a danger `AlertDialog` (`AlertDialogContent variant="destructive"`).
- Exclusive tools use `Toggle` / `ToggleGroup` outline with accent fill + primary border + `aria-pressed`. Inside a `.toolbar-island` the pressed tool instead takes the `--selection` orange (#ff8000, the viewport selection colour) as a tinted fill and text, and mode switches (`toolbar-island-segmented`) take a neutral fill. Selected rows use a whole-row fill; no edge stripes or inset underlines.
- Large icons (asset tiles, catalog cards, project cards) draw at multiples of Lucide's 24-unit grid with whole-pixel line widths (48px with 1-unit lines, 24px with 2), so lines never straddle pixels and read as a faint outline.
- Icon-only controls always have `aria-label`; tooltips are never the only way to discover an action.
- Docked panels omit `PanelFrame` titles when Dockview already shows the tab name.
- Large dialogs use `editor-dialog-large`; small prompts stay content-sized. Headers and actions stay outside scrolling bodies.

## Color families

- Pins (`--pin-*`): arrays use the element color, maps the value color; resolved wildcards paint the connected type; `--pin-wildcard` when unbound.
- Node title roles (`--node-*`) cover events, call parent, functions, pure, flow, variables, latent, debug, Development/Editor Only tape and Behaviour Tree roles. Particle stages map onto node roles through `PARTICLE_STAGE_ROLE` so Basic Emitter and Particle Graph agree.
- Asset kinds (`--asset-*`) are at least 25° apart in hue; tiles tint only the thumbnail well border. Unknown types use a file glyph and `--muted-foreground`.
- Status: `--destructive`, `--success`, `--warning`, `--play` / `--play-foreground`, and `--stop` / `--stop-foreground` for the chrome Stop that replaces Simulate while a Simulation runs. Trace uses `--trace-*`.
- Axes: `--axis-x` = destructive, `--axis-y` = success, `--axis-z` an independent blue (not `--primary`, which is ink). Babylon gizmos cannot read CSS, so `GIZMO_AXIS_COLORS` in [`gizmo-host.ts`](../../../packages/render/src/gizmo-host.ts) hardcodes matching `Color3`s; keep them in sync.

## Brand assets

- Brand artwork is human-authored: sources in [`engine-logos/`](../../../engine-logos/), served files in [`apps/editor/public/branding/`](../../../apps/editor/public/branding/) (resolved by `brandIconSrc` in [`branding.ts`](../../../apps/editor/src/lib/branding.ts)). Copy existing files only; never AI-generate or invent replacements ([no-ai-artwork](../../rules/no-ai-artwork.md)); use Lucide icons for missing glyphs.
- Dev-only Component Gallery: `/?test=1&gallery=1` renders every installed primitive for on-device checks.
