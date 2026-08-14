# Editor UI components

Reusable Editor chrome lives in `@babylonslate/ui` (shadcn / Base UI primitives) and `@babylonslate/editor-kit` (touch-first composites). Graph canvases reuse `@babylonslate/graph-ui`. Do not add raw styled `<input>`, `<select>`, or `<button>` in `apps/editor/src` — compose from this list.

Tokens and action-vs-pressed rules: [theming.md](theming.md). Spec: [engineplan.md](../engineplan.md) (UI composition). Dev-only visual audit: `/?test=1&gallery=1`.

This page lists **kit** components currently in the repo. Feature screens (Homepage, Play overlay, Settings modals, dock panels) are not listed. When you add, change, or remove a reusable component, update this page in the same change (`.cursor/rules/editor-ui-components.mdc`).

## Primitives (`@babylonslate/ui`)

Source: [`packages/ui/src/components/`](../../packages/ui/src/components/). Import as `@babylonslate/ui/components/<name>`. Composition parts (`DialogTitle`, `FieldLabel`, …) belong with the family, not as separate rows.

| Component | What it does | Used for |
| --- | --- | --- |
| **Alert** (`AlertTitle`, `AlertDescription`, `AlertAction`) | Inline status callout. | Boot / project errors in `App` and Homepage; gallery. |
| **AlertDialog** (`AlertDialogTitle`, `AlertDialogAction`, `AlertDialogCancel`, …) | Modal confirm / blocking error. | Unsaved close, Play blocked, Content Browser destructive confirms; NamePromptDialog. |
| **Badge** | Compact status chip. | Compilation errors, Content Browser type tags, global-search result kinds, live-wire “Add Node”. |
| **Button** | Pressable action. Sizes include `touch` / `touch-icon` (44px). Outline = visible action; ghost = tabs / close. | Chrome, panels, catalogs, overlays. |
| **Card** (`CardHeader`, `CardTitle`, `CardDescription`, `CardContent`, `CardFooter`, `CardAction`) | Raised content block. | Homepage project tiles, settings field groups, Compiler Results rows. |
| **Checkbox** | Boolean check control. | PropertyGrid booleans; gallery. |
| **ContextMenu** (`ContextMenuTrigger`, `ContextMenuItem`, `ContextMenuGroup`, …) | Pointer-anchored menu (Radix/Base UI). | Homepage project tiles. Long-press editor menus use editor-kit `ContextMenuOverlay` instead. |
| **Dialog** (`DialogTitle`, `DialogHeader`, `DialogContent`, …) | Centered modal. Title required. | Global search, Play prepare, Content Browser rename/move, CatalogDialog shell, SearchDialog, debug console, Preview session report. |
| **DropdownMenu** (`DropdownMenuTrigger`, `DropdownMenuItem`, `DropdownMenuGroup`, …) | Anchored menu. `DropdownMenuLabel` must sit in a `DropdownMenuGroup`. Chrome menus use `modal={false}` so they do not cover the viewport. | Windows, Debug, Settings, Add, Content Browser item menus, SearchDropdown. |
| **Empty** (`EmptyHeader`, `EmptyTitle`, `EmptyDescription`, `EmptyContent`, `EmptyMedia`) | Empty-state layout. | Homepage with no projects; global search with no hits; UserInterface designer when the Babylon GUI preview fails; gallery. |
| **Field** (`FieldGroup`, `FieldLabel`, `FieldSet`, `FieldLegend`, `FieldDescription`, `FieldError`, `FieldContent`, `FieldTitle`) | Form row layout. Uses **Label** internally — do not invent a parallel label. | Engine / Project Settings (including User Interface custom canvas presets), Homepage create, Content Browser forms, PropertyGrid. |
| **Input** | Single-line text. | Names, search fields, settings strings. |
| **Label** | Accessible control caption. | Not imported by app code; Field wraps it. |
| **Progress** (`ProgressTrack`, `ProgressIndicator`, `ProgressLabel`, `ProgressValue`) | Determinate progress. | Content Browser encode / import. |
| **ScrollArea** (`ScrollBar`) | Overlay scrollbar region. | Gallery, Output Log, Compiler Results, SearchDialog body. |
| **Select** (`SelectTrigger`, `SelectContent`, `SelectItem`, `SelectGroup`, …) | Closed option list. Popup is at least the trigger width (`min-w-(--anchor-width)`), not stretched across the panel. | Engine Settings enums; PropertyGrid enum rows; UserInterface designer canvas preset; Project Settings global font fallback. |
| **Separator** | Horizontal or vertical rule. | Toolbar strips, search dialog, catalog layout. |
| **Sheet** (`SheetTitle`, `SheetContent`, `SheetHeader`, …) | Edge drawer. Title required. | Installed; unused in production chrome. Pick lists use SearchDialog / SearchDropdown; console and session report use Dialog. |
| **Slider** | Bounded numeric track (44px hit area). Accepts a scalar or range array. | PropertyGrid slider rows; Trace playback frame scrubber; gallery. |
| **Switch** | On/off toggle. | Engine / Project Settings booleans. |
| **Textarea** | Multi-line text. | Gallery; not used for Input mappings (structured `InputMappingEditor`). |
| **Toggle** | Pressed/unpressed tool. Selected = accent fill + primary border + `aria-pressed`. | Viewport tools, Outliner filters, chrome Play-adjacent tools; FlagsField bits. |
| **ToggleGroup** (`ToggleGroupItem`) | Exclusive (or multiple) tool set. | Viewport gizmo mode; Tilemap paint tools; gallery. |
| **Tooltip** (`TooltipTrigger`, `TooltipContent`, `TooltipProvider`) | Hover/focus hint. `TooltipProvider` wraps the editor in `App`. | Icon chrome, viewport toolbar, `IconActionButton`. |

Gallery-only today (installed, not yet used in production panels): **Skeleton** (loading placeholder). **Tabs** (`TabsList`, `TabsTrigger`, `TabsContent`) is used by UserInterface / Font / Sprite / graph asset workspaces (design vs logic).

## Composites (`@babylonslate/editor-kit`)

Source: [`packages/editor-kit/src/`](../../packages/editor-kit/src/). Import from `@babylonslate/editor-kit`.

| Component | What it does | Used for |
| --- | --- | --- |
| **PanelFrame** | Docked panel shell (`--sidebar` body, optional title/toolbar). Omit the title when Dockview already shows the tab name. | Outliner, Details, Inspector, Graph, Class, Prefab, Output Log, Compiler Results; AnimationGraph Parameters / States / Details columns. |
| **ToolbarStrip** | Horizontal chrome row of tools. | Component Gallery; intended for panel toolbars. |
| **PropertyGrid** | Typed Details rows: number, vector3 (2–4 axes), boolean, text, enum, color (`ColorField`), slider, flags (`FlagsField`), asset (guid stored; `displayLabel` on the button). | Scene Details (typed asset / physics / Game Instance), Inspector (node / Log / Print; action/axis / enumRef defaults), UserInterface widget details (alignment, left/top, width/height, layout padding), Sprite / Tileset / Tilemap / Structure settings, AnimationGraph state and transition Details. |
| **ColorField** | Native color swatch plus a pasteable `#rrggbb` field. | Light color; Inspector color pin defaults; gallery. |
| **FlagsField** | Compact 44px bitmask toggles (Layer 0–31 or named labels). | Collider `layer` / `mask`; gallery. |
| **TreeView** | Flattened touch tree (`--chrome-row` 28px): select, expand, reparent, activate. `reparentArm: "immediate"` starts a parent drag after 8px; `"hold"` (default) waits 250ms so lists can scroll. Disclosure only when `hasChildren`. Trailing controls do not start a drag. | Outliner, Components, and UserInterface widget hierarchy (immediate drag-to-parent); Content Browser sidebar and Move dialog (hold); Class members (trailing **+** on each section). |
| **NumericDragField** | Scrub-by-drag numeric (axis accent); tap to type. Coalesces undo via begin/end. | PropertyGrid number / vector3 / slider / color; InputMappingEditor axis extras; gallery. |
| **NumberField** | Numeric text that keeps an empty draft; commits in-range values, restores on blur. | Engine Settings numeric fields (including User Interface custom preset size and safe-area insets); Project Settings autosave, pixels-per-unit, play frame cap; Trace playback frame. |
| **SearchInput** | Text field with a trailing clear control. | CatalogDialog, SearchDialog, SearchDropdown, global search, Content Browser, Content Browser Move dialog. |
| **SearchDialog** | Searchable item list in a compact centered Dialog. | AssetPicker; ClassPicker; SceneComponentPicker (planned); gallery. Add Component / Place Actors use CatalogDialog instead. |
| **SearchDropdown** | Searchable `DropdownMenu` (`modal={false}`) anchored to a trigger. Scrollable; width is content-sized, not full viewport. | Tilemap tile palette; PinTypePicker; gallery. |
| **AssetPicker** | Asset-guid picker on SearchDialog, optional None row and type filter. | Scene Details mesh / sprite / tilemap / widget / animation-graph rows; Project Settings default font and **Startup Scene**; Font fallbacks; Sprite and Tileset Texture; UserInterface nested UI, image, font, and visual override; AnimationGraph clip (Sprite or Animation). |
| **ClassPicker** | Class-id picker on SearchDialog (engine + project Class assets). | Scene Game Instance (GameInstance lineage). |
| **SceneComponentPicker** | Planned (`p-lighting-camera`): SearchDialog picker of components in the open scene; `allowedClassIds` is a source-code filter (no user type dropdown); optional None; button shows actor name + component. | Scene **Default Camera** (`CameraComponent` only). Reuse for other scene-settings that name a component (light, listener). |
| **NamedListEditor** | Reorderable named string rows (add / remove / up / down, 44px). Optional custom item control or Add-only. | Project Settings sorting layers; Font `fallbackGuids`; ParameterListEditor enum values; AnimationGraph parameters. |
| **InputMappingEditor** | Actions/axes with bindings, listen-to-bind, device toggles, touch control ids. | Project Settings Input. |
| **BindingCaptureButton** | Listen-to-bind: next keydown / mouse button / gamepad. | InputMappingEditor bindings. |
| **NamePromptDialog** | AlertDialog + 44px name field. Replaces `window.prompt`. | Class panel member add; UserInterface Logic members; UserInterface widget rename. |
| **CatalogDialog** | Large centered dialog: category nav, non-autofocused search, scrollable body. | Engine / Project Settings, Place Actors, Add Component, graph NodePalette, UserInterface Add Widget. |
| **CatalogItemButton** | Full-width outline row for a catalog entry. | Place Actors, Add Component, UserInterface Add Widget. |
| **TypeVisualIcon** | Colored Lucide glyph for an asset / class family (`resolveTypeVisual`). | Outliner, Details, Prefab, Content Browser, global search, Place Actors, Add Component, AssetPicker, ClassPicker, SceneComponentPicker, document tabs. |
| **TypeColorMark** | Swatch + label for a DataTypes color token (`pinColorVar` / `assetColorVar`). | PinTypePicker rows; Component Gallery Data Types section. |
| **PinTypePicker** | Compact `SearchDropdown` of pin kinds with `TypeColorMark` (bool, int, float, string, enum, vec2/vec3, object, struct). Function inspectors also pass **exec**. | Structure field type; Class variable type; PinListEditor rows. |
| **PinListEditor** | Compact Unreal-like pin rows (color chip + name + type picker + up/down/remove). Optional in/out add buttons. Optional/default/enum details on the selected row. | ScriptInterface method pins; Class function **Inputs** and **Outputs** (two editors, exec included). |
| **ParameterListEditor** | Thin `PinListEditor` wrapper restricted to string/float/int/bool/enum. | Inspector Execute JavaScript Inputs/Outputs; Event On Command Run / BDebugCommand. |
| **SelectableText** | Opt-in selectable span inside a `user-select: none` shell. | Logs, compiler messages, Play overlay copy, gallery code snippets. |
| **NestedMenu** | Data-driven dropdown or pointer-anchored menu with recursive submenus (actions, checkboxes, separators, labels). Submenus open on tap, not hover-only. Pointer-anchored `OverlayMenu` measures the panel and **clamps** to the viewport (8px margin); overflowing submenus open to the left of the parent. | Windows (Editor Utilities); Outliner row ⋯; UserInterface hierarchy ⋯; viewport settings; gallery. Long-press sites use it through `ContextMenuOverlay`. |
| **ContextMenuOverlay** | Pointer-anchored menu driven by `useContextMenu` (500ms hold or `contextmenu`). Renders flat or nested `NestedMenu` items. Stays fully on-screen via `clampOverlayMenuPosition`. | Viewport, Content Browser tiles/grid; Class member rows; gallery. Outliner and UserInterface hierarchy use a trailing ⋯ `NestedMenu` instead of a row long-press. |

Related hooks (not components): `useContextMenu`, `useHoldDragMenu`, `useSuppressNativeContextMenu`, `useSuppressIosEditingGestures`, `usePreventDocumentOverscroll`. Label helpers: `humanizePropertyLabel`, `formatEventMemberName`, `formatEventTitle`, `formatBindingLabel`. Type lookup: `resolveTypeVisual`, `resolveActorTypeVisual`. History: `documentHistoryHotkey`.

## Graph (`@babylonslate/graph-ui`)

Reusable by script, shader, animation, and behaviour-tree graphs.

| Component | What it does | Used for |
| --- | --- | --- |
| **GraphEditor** | Touch-first React Flow shell: Blueprint node chrome, tap- and drag-to-connect, cancelled pin-drag disconnect, Break Links on the selection, marquee, pin-filtered drop-to-add. Reconciles external `initialGraph` updates (undo/redo, Inspector) without emitting `onChange`. | Graph document panel; UserInterface Logic tab; Shader / AnimationGraph hosts (catalog `__pins` hydrated so Add Node is not an empty box; Anim Graph persists `AnimState.position`). |
| **NodePalette** | CatalogDialog of nodes with role-color chips; optional pin compatibility filter. | Add Node from GraphEditor (empty-pane connect-end and Add Node). |

## App wrappers

Reusable pieces in `apps/editor/src/components/` that are not one-off screens.

| Component | What it does | Used for |
| --- | --- | --- |
| **IconActionButton** ([`icon-action-button.tsx`](../../apps/editor/src/components/icon-action-button.tsx)) | Icon-only `Button` with `aria-label` plus Tooltip. | Chrome bar, Outliner, Details, Prefab panel. |
| **ContentBrowserAssetTile** ([`content-browser-asset-tile.tsx`](../../apps/editor/src/components/content-browser-asset-tile.tsx)) | Asset card: `--card` thumb well (or image) with a 2px type-colored border inset 2px so it follows the Card’s top `rounded-xl`, `--card` text panel, selection, long-press / right-click menu. Pointer events do not bubble to the empty-grid menu. | Content Browser grid. |
| **ContentBrowserFolderTile** ([`content-browser-folder-tile.tsx`](../../apps/editor/src/components/content-browser-folder-tile.tsx)) | Uncolored folder card (`--card` well, muted glyph); click selects, double-click navigates. | Content Browser grid (child folders first). |
| **ContentBrowserMoveDialog** ([`content-browser-move-dialog.tsx`](../../apps/editor/src/components/content-browser-move-dialog.tsx)) | Destination picker: item preview, folder search, `TreeView` with muted illegal rows. Move or copy of one or many selected items. | Content Browser **Move…** / **Copy to Folder…** for the current tile selection. |

Not kit (single call site): `BrandLogo` (Homepage), `JsBodyEditor` (Inspector Execute JavaScript body).
