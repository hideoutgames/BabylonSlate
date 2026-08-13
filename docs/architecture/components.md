# Editor UI components

Reusable Editor chrome lives in `@babylonslate/ui` (shadcn / Base UI primitives) and `@babylonslate/editor-kit` (touch-first composites). Graph canvases reuse `@babylonslate/graph-ui`. Do not add raw styled `<input>`, `<select>`, or `<button>` in `apps/editor/src` — compose from this list.

Tokens and action-vs-pressed rules: [theming.md](theming.md). Spec: [engineplan.md](../engineplan.md) (UI composition). Dev-only visual audit: `/?test=1&gallery=1`.

This page lists **kit** components currently in the repo. Feature screens (Homepage, Play overlay, Settings modals, dock panels) are not listed. When you add, change, or remove a reusable component, update this page in the same change (`.cursor/rules/editor-ui-components.mdc`).

## Primitives (`@babylonslate/ui`)

Source: [`packages/ui/src/components/`](../../packages/ui/src/components/). Import as `@babylonslate/ui/components/<name>`. Composition parts (`DialogTitle`, `FieldLabel`, …) belong with the family, not as separate rows.

| Component | What it does | Used for |
| --- | --- | --- |
| **Alert** (`AlertTitle`, `AlertDescription`, `AlertAction`) | Inline status callout. | Boot / project errors in `App` and Homepage; gallery. |
| **AlertDialog** (`AlertDialogTitle`, `AlertDialogAction`, `AlertDialogCancel`, …) | Modal confirm / blocking error. | Unsaved close, Play blocked, Content Browser destructive confirms. |
| **Badge** | Compact status chip. | Compilation errors, Content Browser type tags, global-search result kinds, live-wire “Add Node”. |
| **Button** | Pressable action. Sizes include `touch` / `touch-icon` (44px). Outline = visible action; ghost = tabs / close. | Chrome, panels, catalogs, overlays. |
| **Card** (`CardHeader`, `CardTitle`, `CardDescription`, `CardContent`, `CardFooter`, `CardAction`) | Raised content block. | Homepage project tiles, settings field groups, Compiler Results rows. |
| **Checkbox** | Boolean check control. | PropertyGrid booleans; gallery. |
| **ContextMenu** (`ContextMenuTrigger`, `ContextMenuItem`, `ContextMenuGroup`, …) | Pointer-anchored menu (Radix/Base UI). | Homepage project tiles. Long-press editor menus use editor-kit `ContextMenuOverlay` instead. |
| **Dialog** (`DialogTitle`, `DialogHeader`, `DialogContent`, …) | Centered modal. Title required. | Global search, Play prepare, Content Browser rename/move, CatalogDialog shell. |
| **DropdownMenu** (`DropdownMenuTrigger`, `DropdownMenuItem`, `DropdownMenuGroup`, …) | Anchored menu. `DropdownMenuLabel` must sit in a `DropdownMenuGroup`. Chrome menus use `modal={false}` so they do not cover the viewport. | Windows, Debug, Settings, Add, Content Browser item menus. |
| **Empty** (`EmptyHeader`, `EmptyTitle`, `EmptyDescription`, `EmptyContent`, `EmptyMedia`) | Empty-state layout. | Homepage with no projects; global search with no hits; gallery. |
| **Field** (`FieldGroup`, `FieldLabel`, `FieldSet`, `FieldLegend`, `FieldDescription`, `FieldError`, `FieldContent`, `FieldTitle`) | Form row layout. Uses **Label** internally — do not invent a parallel label. | Engine / Project Settings (including User Interface custom canvas presets), Homepage create, Content Browser forms, PropertyGrid, UserInterface desired size. |
| **Input** | Single-line text. | Names, search fields, settings strings. |
| **Label** | Accessible control caption. | Not imported by app code; Field wraps it. |
| **Progress** (`ProgressTrack`, `ProgressIndicator`, `ProgressLabel`, `ProgressValue`) | Determinate progress. | Content Browser encode / import. |
| **ScrollArea** (`ScrollBar`) | Overlay scrollbar region. | Gallery, Output Log, Compiler Results, SearchSheet body. |
| **Select** (`SelectTrigger`, `SelectContent`, `SelectItem`, `SelectGroup`, …) | Closed option list. | Engine Settings enums; PropertyGrid enum rows; UserInterface designer canvas preset. |
| **Separator** | Horizontal or vertical rule. | Toolbar strips, search dialog, catalog layout. |
| **Sheet** (`SheetTitle`, `SheetContent`, `SheetHeader`, …) | Edge drawer. Title required. | SearchSheet (add-component / asset picker / gallery). |
| **Switch** | On/off toggle. | Engine / Project Settings booleans. |
| **Textarea** | Multi-line text. | Project Settings notes. |
| **Toggle** | Pressed/unpressed tool. Selected = accent fill + primary border + `aria-pressed`. | Viewport tools, Outliner filters, chrome Play-adjacent tools. |
| **ToggleGroup** (`ToggleGroupItem`) | Exclusive (or multiple) tool set. | Viewport gizmo mode; gallery. |
| **Tooltip** (`TooltipTrigger`, `TooltipContent`, `TooltipProvider`) | Hover/focus hint. `TooltipProvider` wraps the editor in `App`. | Icon chrome, viewport toolbar, `IconActionButton`. |

Gallery-only today (installed, not yet used in production panels): **Skeleton** (loading placeholder). **Tabs** (`TabsList`, `TabsTrigger`, `TabsContent`) is used by UserInterface / Font / Sprite / graph asset workspaces (design vs logic).

## Composites (`@babylonslate/editor-kit`)

Source: [`packages/editor-kit/src/`](../../packages/editor-kit/src/). Import from `@babylonslate/editor-kit`.

| Component | What it does | Used for |
| --- | --- | --- |
| **PanelFrame** | Docked panel shell (`--sidebar` body, optional title/toolbar). Omit the title when Dockview already shows the tab name. | Outliner, Details, Inspector, Graph, Class, Prefab, Output Log, Compiler Results. |
| **ToolbarStrip** | Horizontal chrome row of tools. | Component Gallery; intended for panel toolbars. |
| **PropertyGrid** | Typed Details rows: number, vector3, boolean, text, enum, color, asset. | Scene Details, Inspector (node / Log / Print), UserInterface widget details (including nested UI asset), Tileset / Tilemap settings. |
| **TreeView** | Flattened touch tree (32px rows): select, expand, reparent, activate, long-press. | Outliner, Class members, Prefab hierarchy, Content Browser Move dialog, UserInterface widget hierarchy. |
| **NumericDragField** | Scrub-by-drag numeric (axis accent); tap to type. Coalesces undo via begin/end. | PropertyGrid number / vector3 / color; gallery. |
| **NumberField** | Numeric text that keeps an empty draft; commits in-range values, restores on blur. | Engine Settings numeric fields (including User Interface custom preset size and safe-area insets); Project Settings via CatalogDialog; UserInterface desired width/height. |
| **SearchInput** | Text field with a trailing clear control. | CatalogDialog, SearchSheet, global search, Content Browser, Content Browser Move dialog. |
| **SearchSheet** | Searchable item list in a Sheet (bottom on touch, right on desktop). | AssetPicker; gallery. Add Component / Place Actors use CatalogDialog instead. |
| **AssetPicker** | Asset-guid picker on SearchSheet, optional None row and type filter. | PropertyGrid asset rows (gallery); Details mesh/texture picks; UserInterface nested-UI picker (self and cycle partners excluded). |
| **CatalogDialog** | Large centered dialog: category nav, non-autofocused search, scrollable body. | Engine / Project Settings, Place Actors, Add Component, graph NodePalette. |
| **CatalogItemButton** | Full-width outline row for a catalog entry. | Place Actors, Add Component. |
| **TypeVisualIcon** | Colored Lucide glyph for an asset / class family (`resolveTypeVisual`). | Outliner, Details, Prefab, Content Browser, global search, Place Actors, Add Component, AssetPicker, document tabs. |
| **ParameterListEditor** | Named, typed, reorderable pin/parameter rows (type, optional, default, enum, up/down). | Inspector Execute JavaScript Inputs/Outputs; Event On Command Run / BDebugCommand; Class / ScriptInterface signatures. |
| **SelectableText** | Opt-in selectable span inside a `user-select: none` shell. | Logs, compiler messages, Play overlay copy, gallery code snippets. |
| **ContextMenuOverlay** | Pointer-anchored menu driven by `useContextMenu` (500ms hold or `contextmenu`). | Viewport, Outliner, Content Browser. |

Related hooks (not components): `useContextMenu`, `useHoldDragMenu`, `useSuppressNativeContextMenu`, `useSuppressIosEditingGestures`, `usePreventDocumentOverscroll`. Label helpers: `humanizePropertyLabel`, `formatEventMemberName`, `formatEventTitle`. Type lookup: `resolveTypeVisual`, `resolveActorTypeVisual`.

## Graph (`@babylonslate/graph-ui`)

Reusable by script, shader, animation, and behaviour-tree graphs.

| Component | What it does | Used for |
| --- | --- | --- |
| **GraphEditor** | Touch-first React Flow shell: Blueprint node chrome, tap- and drag-to-connect, cancelled pin-drag disconnect, marquee, pin-filtered drop-to-add. | Graph document panel. |
| **NodePalette** | CatalogDialog of nodes with role-color chips; optional pin compatibility filter. | Add Node from GraphEditor (empty-pane connect-end and Add Node). |

## App wrappers

Reusable pieces in `apps/editor/src/components/` that are not one-off screens.

| Component | What it does | Used for |
| --- | --- | --- |
| **IconActionButton** ([`icon-action-button.tsx`](../../apps/editor/src/components/icon-action-button.tsx)) | Icon-only `Button` with `aria-label` plus Tooltip. | Chrome bar, Outliner, Details, Prefab panel. |
| **ContentBrowserAssetTile** ([`content-browser-asset-tile.tsx`](../../apps/editor/src/components/content-browser-asset-tile.tsx)) | Asset card: thumbnail or type glyph, selection, long-press / right-click menu. | Content Browser grid. |
| **ContentBrowserFolderTree** ([`content-browser-folder-tree.tsx`](../../apps/editor/src/components/content-browser-folder-tree.tsx)) | Nested folder rows with tap-to-select and long-press / right-click menu. | Content Browser sidebar. |
| **ContentBrowserMoveDialog** ([`content-browser-move-dialog.tsx`](../../apps/editor/src/components/content-browser-move-dialog.tsx)) | Destination picker: item preview, folder search, `TreeView` with muted illegal rows. | Content Browser **Move…** for assets and folders. |

Not kit (single call site): `BrandLogo` (Homepage), `JsBodyEditor` (Inspector Execute JavaScript body).
