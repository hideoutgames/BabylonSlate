# Touch and gestures

BabylonSlate is touch-first. Do not assume hover or right-click.

## Global chrome

| Gesture | Target | Action |
| --- | --- | --- |
| Long-press (~500 ms, stationary) | Dockview tab/header chrome | Drag panel |
| Long-press (~500 ms, stationary) | Panel content (when menu enabled) | App context menu |
| Tap | Buttons, tabs, list items | Primary action |
| `contextmenu` | Desktop secondary click | Same as long-press menu |

### Native menu suppression

Two mechanisms, both required:

- `-webkit-touch-callout: none` on the shell stops the iOS text callout.
- `useSuppressNativeContextMenu` (applied once at the shell) calls `preventDefault` on `contextmenu` document-wide, so long-press and right-click reach our menu instead of the browser's.
- Pointer-anchored overlays (`ContextMenuOverlay` / `NestedMenu` `OverlayMenu`) clamp to the viewport minus 8px after measuring the panel. Submenus flip to the left of the parent when the right side would clip. Tall menus scroll (`overflow-y-auto`).

Inputs, textareas, `contenteditable` and anything inside `SelectableText` keep the platform menu, since that is where cut/copy/paste is still wanted.

### iOS three-finger undo/redo

iOS 13+ standalone / Add to Home Screen maps three-finger swipe and tap to system undo/redo. That fights the viewport pan gesture and delays `pointermove` while the recognizer decides.

- `useSuppressIosEditingGestures` (applied once at the shell) `preventDefault`s 3+ finger `touchstart`/`touchmove` and `beforeinput` `historyUndo`/`historyRedo` document-wide.
- Inputs, textareas, `contenteditable`, and `SelectableText` keep system typing undo.
- Editor canvases (scene and Prefab Preview) also `preventDefault` every `touchstart`/`touchmove` with a non-passive listener so iOS does not hold pointer events for gesture recognition. The canvas already uses `touch-none` and does not scroll.
- Desktop document history binds **Mod+Z** (undo) and **Mod+Shift+Z** / **Mod+Y** (redo) on the chrome bar. `documentHistoryHotkey` no-ops inside native-editing targets and while `activePointerCount >= 3` so a three-finger viewport pan cannot fire document undo.

### Cancellation

`useContextMenu` cancels a pending long-press when the pointer moves past 8px or on scroll (captured document-wide, since `scroll` does not bubble). The 500ms delay and 8px tolerance deliberately match Dockview's `LongPressDetector` defaults, so a panel drag and a context menu can never both fire from one gesture.

Nested `NestedMenu` submenus open on **tap / click**, not hover-only. Large catalogs still use `CatalogDialog` / `SearchDialog` rather than nested menus.

## Document scroll lock

The editor shell is a full-viewport IDE, not a scrollable web page. Document rubber-band overscroll is disabled so drags on the viewport, dock chrome, and other non-scrollable areas do not bounce the whole page (especially on iOS Safari).

| Layer | Mechanism | Scope |
| --- | --- | --- |
| CSS | `overflow: hidden` and `overscroll-behavior: none` on `html`, `body`, `#root`, and app shell roots | All platforms |
| CSS | `overscroll-behavior: contain` on intentional scroll regions | Content browser, chrome closable-tab scroller, homepage Start gallery and project list |
| JS | `usePreventDocumentOverscroll` — `touchmove` guard on coarse pointers | iOS Safari / touch fallback |
| Native | WKWebView `scrollView.bounces = false` | Capacitor iOS app only |

### Standalone (Add to Home Screen)

`apps/editor/index.html` sets `viewport-fit=cover` plus `apple-mobile-web-app-capable` / `mobile-web-app-capable` so a Pages home-screen app is fullscreen and does not resize-churn on the home indicator. The three-finger undo suppression above must ship with those tags; capable meta otherwise makes iOS editing gestures more aggressive.

### Regions that still scroll internally

- Homepage Start gallery — horizontal template cards (`overflow-x-auto overscroll-x-contain`, nowrap)
- Homepage project list — vertical recents (`overflow-y-auto overscroll-y-contain touch-pan-y`); Search / Filter / Sort stay above the scrollport. Recents rows are Cards (not full-width buttons) so a finger pan scrolls the list; long-press still opens `ContextMenuOverlay` (8px cancel). A trailing **X** opens Remove (native) or Delete (web OPFS) confirm instead of eating the pan.
- Create Project dialog — templates pane and the right-hand **form** may scroll vertically; the right pane is `overflow-x-hidden` and the Cancel / Create footer stays pinned. Name is not autofocused on coarse pointers so the iPad keyboard does not steal height.
- Chrome closable-tab scroller (`.editor-chrome-tabs-scroll`) — horizontal overflow; pinned Content Browser and the open Scene tab stay put
- Content browser — folder tree and asset grid
- Graph panel — React Flow pan/zoom (unchanged)
- Global Search results (`global-search-results`) — overflow list inside a fixed-height dialog
- SearchDialog / AssetPicker / ClassPicker / SceneComponentPicker (`*-body`) — native `overflow-y-auto overscroll-y-contain touch-pan-y` with a definite `pickerListHeightPx` cap (16rem). Rows are `role="option"` divs (`buttonVariants` ghost touch, `touch-pan-y`), not native buttons, so a finger pan on a row scrolls. WindowedList slots also use `touch-pan-y`. The document overscroll guard allows the body because it is `overflow-y: auto`.
- AddFunctionDialog / Add Event (`*-body`) — same native overflow list and non-button option rows as SearchDialog

## Virtual keyboard

Focusing a text field on iPad raises the keyboard and can cover a centered modal. `CatalogDialog` search is **not** autofocused on open (`initialFocus` is the scrollable body; `autoFocusSearch` defaults to false). That includes Add Node, Place Actors, Add Component, and Settings. Global Search may autofocus because it is a search-first UI with no category list.

## Dockview

- Dockview 8's `dndStrategy` defaults to `'auto'`: HTML5 drag for mouse, pointer events for touch and pen. Touch panel drag therefore needs no extra configuration.
- Tab strips are **26px on coarse pointers** and **18px on fine pointers**; grips stay 44px+. Editor chrome and panel headers use `--chrome-row` (28px).
- Sashes stay visually thin (4px) but carry a widened hit area via a transparent pseudo-element, because Dockview sizes the sash element itself from an internal constant that CSS cannot override.
- Panel **content** is a gesture-safe zone — viewport and graph handle their own gestures.
- No popout / floating groups on iOS/Android.

## Viewport (Babylon)

- **One finger**: tap to pick/select. **Ctrl / Meta / Shift** tap adds that actor (or Prefab component) without replacing the selection. In **3D**, drag looks in place (yaw/pitch; camera position stays put) unless Viewport Settings **Pivot Around Center** is on, in which case the same drag orbits around `camera.target`. In **2D**, drag **pans** 1:1 with the pointer (the world point under the finger stays put; same scale/axes as three-finger pan). **Hold ~250ms then move** marquees in 2D (actors whose origin falls inside the rect). **Drag Select** (viewport toolbar) hijacks the next one-finger drag in 2D and 3D: no pan/look, live overlay, commit on release, then the tool unpresses. Gizmo handle hits skip look/pan so transform drags still win, except while Drag Select is armed. A pointer-up that started on a gizmo is not a pick — releasing a handle must not clear the selection. While **Game Camera** preview is on, one-finger look/pan is ignored. **SceneLayer** (and SceneLayerActor prefabs): interior drag **moves** XY, edge/corner handles **resize** (opposite side fixed), the knob **above the box** **rotates Z**; world 2D pan/gizmo rules are unchanged.
- **Pinch** (two fingers, spread change) zooms / dollies **about the pointer / pinch centroid** (same contract as tilemap). Two-finger translation does not orbit or pan. 2D pinch and wheel are continuous, including when pixel-perfect integer zoom steps is on. Ending a pinch with one finger still down starts a new stroke (`moved = false`, `skipLook`) so leftover look does not jump. **Game Camera** preview ignores editor zoom.
- **Three fingers** pan (move the camera). In 2D this is the same 1:1 frustum / CSS-pixel mapping as one-finger pan; in 3D it uses a fixed world-units-per-pixel scale.
- **WASD** flies in 3D (look-relative) and pans on XY in 2D. Ignored while typing, while Play is open, or when the canvas is hidden. WASD still flies when **Pivot Around Center** is on so the orbit center can be translated.
- **Editor camera joystick** (`settings.editorJoystickEnabled`) is an on-screen stick (default **on**; missing keys normalize to true; user off persists `false`) that drives the same fly/pan path, or **orbits** in 3D when **Pivot Around Center** is on. Scene and Prefab **Viewport Settings** menus expose **Viewport Mode** (PBR / Unlit / Wireframe), Snap, Show Grid, Joystick, **Pivot Around Center**, and Game Camera; Scene persists Snap / Show Grid / Joystick, Prefab uses live context (joystick also defaults on). Viewport Mode, Pivot Around Center, and Game Camera are session-only (not scene JSON). Not the P9 game `TouchJoystick`.
- **Double-tap** an Outliner actor or Prefab Components row (including Prefab Root) frames that actor once. 3D moves the orbit target to the visual AABB center and relocates the eye to a slight, bounds-aware distance (default radius 12, larger meshes pull back further; never below ~2× `minZ`). The camera is not parented or locked to the actor. 2D pans the target only. **Frame Selection** uses the same path.
- **Gizmo drag** coalesces to one undo step: `SetActorTransformCommand` (`transform:{actorId}`) for one actor, `SetActorsTransformsCommand` (`transforms:{sortedIds}`) when several selection roots move together.
- Canvas uses `touch-none` plus non-passive touch `preventDefault` so UI chrome and iOS system gestures do not steal look / pinch / pan.
- Selection on explicit tap pick, not hover.

## Tileset atlas and Tilemap paint

Same pinch contract as the viewport: scale about the midpoint, then apply two-finger translation. Wheel zooms about the cursor. Canvases use `touch-none`. **Move** is the default tool in both editors (`applyPointerPan`). Two-finger pinch/pan and wheel zoom stay available in every tool. A second finger drops any in-progress one-finger paint/select stroke so pinch does not paint.

| Gesture | Target | Action |
| --- | --- | --- |
| Tap | Tileset Preview cell | Select that tile (and stamp collision when **Paint Collision** is on). In **Move**, a tap is movement < 8px; a drag pans |
| One-finger drag | Tileset Preview (Move) | Pan the atlas (`data-pan-x` / `data-pan-y`) |
| Pinch / wheel | Tileset Preview atlas | Pan-zoom the sheet (`AtlasTileGrid`) |
| One-finger drag | Tilemap Paint **Move** | Pan the view (`applyPointerPan`) |
| One finger | Tilemap Paint brush and friends | Paint with the current tool |
| Two-finger pinch | Tilemap Paint canvas | Zoom about the midpoint; translation pans (`applyPinchView`). Cell size clamped 8–96 CSS px (default 32) |
| Wheel | Tilemap Paint canvas | Zoom about the cursor (`applyWheelZoom`) |

## Graph (React Flow)

- One-finger pan/zoom inside graph panel only. Zoom-out floor is 10% (`GRAPH_MIN_ZOOM` 0.1); zoom-in ceiling is 1.5. Pinch, wheel, and Controls zoom; **double-tap / double-click does not** (`zoomOnDoubleClick={false}`). **Tap empty pane** clears selection. **Hold empty pane ~250ms, then move** marquees via a custom overlay painted **above** React Flow (`attachGraphPaneMarquee`; do not steal one-finger pan until the hold arms). Once armed, mouse/touch pan events are swallowed and XYFlow `panOnDrag` is turned off so the overlay can select. XYFlow `selectionOnDrag` is not used — it cannot convert a gesture that already started as a pan. Canvas background uses chrome `--card` for contrast.
- **Class / Component tree → graph:** dragging a member row shows `GraphDropHint` (`+` over the canvas, ban icon elsewhere) until drop.
- **Tap-to-connect:** tap an output pin, then an input pin (primary mobile path; shipped in `p5-graph-ui`). Pin hit boxes are `--touch-target` (44px); visual pins are `--graph-pin-size` (22px). Wires use `--pin-*` colors and 4–5px strokes.
- **Drag-to-connect:** shipped. React Flow `onConnect` / `isValidConnection` persist the same `addEdge` path as tap-to-connect. Connection preview uses the dragged pin’s color. While the wire is in the empty-canvas **Add Node zone** (outside a **96px screen-space** safe zone around the **source pin** and **compatible opposite pins**, and not over a node body), a non-interactive **Tap to Cancel** badge follows the wire end. **Releasing** in that zone opens Add Node. A pick places the node at the **wire-end flow position** from the drag pointer at release (`screenToFlowPosition`, same conversion as Behaviour Tree release add-node) — not a second finger and not raw store `connection.to`. A **second pointer** (another finger) while that drag is still held **cancels** the rubber-band immediately and does **not** open Add Node (lifting the drag finger must not open it either). Existing wires on the pin stay. **Context Sensitive** (default ON) pin-filters that menu to the dragged pin; a pick auto-wires with the same replace rule as a direct connect. Off shows the host-legal catalog. Releasing without snapping a handle and without opening Add Node **breaks all wires on that pin** only when the pointer is still in the safe zone and not on the source handle. A tap or drop that stays on the source handle does not disconnect (tap-to-connect still works). Dismissing Add Node without picking a node also leaves existing wires. Behaviour trees pass `connectEndMode="add-node"`: releasing a drag off a handle opens Add Node even when short and never breaks structural edges (still cancels when the pointer is over a node or snapped handle). The live-wire badge is **Tap to Cancel**. A **second pointer** while that drag is held cancels the rubber-band and does **not** open Add Node. A pending pin plus empty-pane tap cancels tap-to-connect instead of opening the palette; double-tap with no pending pin still opens Add Node. Animation Graph State Machine uses `connectEndMode="zone-add-node"`: far empty-canvas release opens Add State (**Release to Add Node** badge); release on or near a compatible pin (including an occupied plate) snap-connects; near-source tap/release and a second pointer cancel without breaking transitions; the node body is the move target (thin 16px side handles, not 44px plates). Overlay **Break Links** also drops a selected blend-rule edge when no nodes are selected. Animation Object and nested rule graphs stay on the default script-graph contract. **Exec** pins allow multiple incoming and outgoing wires (flow merge / fan-out). **Data inputs** take one wire; connecting a second source **replaces** the previous. Data outputs still fan out to many inputs.
- **Double-tap empty pane** opens Add Node with all **host-legal** nodes (not the whole engine catalog) unless the host sets `emptyPaneDoubleTapAddsNode={false}`. That gesture does not zoom the canvas. Empty-pane right-click / long-press opens the same Add Node catalog even when the host has no node `contextMenuItemsForNode`. Search and category reset on every open. The graph toolbar has a **+** / Add node control (`graph-add-node`, Lucide `PlusIcon`, outline, same pattern as Class member **+**). There is no persistent floating Add node FAB.
- Overlay toolbar: Copy / Paste / Delete on the selection; **Break Links** drops every incident wire on selected nodes (nodes stay), or the selected edge when a blend rule is selected; **Format** walks each selected chain root independently: exec then-chain stays a horizontal highway, stacked exec successors sit a node-height apart, data/pure trees hang below-left of their consumer, and a selected pure node walks data-out down-right. Unconnected parents do not merge onto the first path. Behaviour Tree hides Copy, Paste, Break Links, and Format, and adds **Auto Arrange**.
- Node palette is a centered `CatalogDialog` (search **not** autofocused); long-press / secondary click for node context menus when enabled.
- **Behaviour tree node drag:** free X/Y from the header handle (`.bt-node-drag-handle`). Attachments use `nodrag`. A completed move persists `editorPositions` and stably re-sorts siblings by X; Auto Arrange must not change `children[]`.

## Document tabs (chrome bar)

| Gesture | Action |
| --- | --- |
| Quick horizontal swipe on tab strip | Scroll overflow tabs |
| Tap tab label | Select tab |
| Tap close | Close tab |
| Long-press (~300 ms, stationary) on tab, then drag horizontally | Reorder tab (dnd-kit); distinct from Dockview panel drag |

## Content Browser

| Gesture | Action |
| --- | --- |
| Tap / click a tile | Replace selection with that tile |
| Tap+drag across cards | Paint-select every card the pointer crosses (replaces the previous set) |
| Tap / click empty grid (padding, gaps — not a tile) | Clear asset and folder selection |
| Toolbar **Deselect All** | Clear asset and folder selection |
| Toolbar **Delete (N)** | Open the delete confirm. Counted outline control; does not delete on the first tap. |
| Double-tap / double-click an asset tile | Open the document (`openOrFocusDocument`) |
| Double-tap / double-click a folder tile | Navigate into that folder |
| Double-tap / double-click **empty grid** | Open New Asset (writable roots only; not the long-press create menu) |
| Move past ~8px on a **tile** | Paint-select (do not open the menu; do not scroll the grid for that gesture) |
| Move before ~500ms on **empty grid** | Scroll (do not open the menu) |
| Hold still ≥500ms or right-click on a **tile** | Add that tile if needed, then open the asset or folder context menu. Tile pointer events do not bubble to the empty-grid menu. |
| Hold still ≥500ms or right-click on **empty grid** | New Folder, New Asset, Import |
| Left tree: tap folder | Set the grid’s current folder |
| Left tree: tap asset | Set the grid to that asset’s parent and select the guid |
| Left tree: Ctrl/Shift/Meta click, horizontal swipe ≥44px, or two-finger tap | Add or range-select folders and assets (same `TreeView` contract as the Outliner) |
| Left tree: double-tap asset | Open the asset |
| Left tree: hold ~250ms then drag | Reparent (`moveAsset` / `moveFolder`). Drop on the **middle** of a folder row moves into that folder; the **top/bottom 8px** of a folder row (1px insert line, no row highlight) moves into that folder’s **parent** instead. Asset rows always resolve to the asset’s parent. If the dragged row is in the current selection, the collapsed selection moves (folder+descendant overlap omits the descendants; folder select does not auto-select children). Dragging an unselected row moves only that row. Pointer capture waits until that hold arms; rows are not `touch-none`, so early movement still scrolls. No context menu on the tree. Root `assets` is not draggable. |
| Context-menu **Move…** / **Copy to Folder…** | Opens `ContentBrowserMoveDialog` for the whole selection (`moveAsset` / `copyAsset` / `moveFolder` / `copyFolder`) |
| Context-menu **Copy Asset Reference** | Exactly one asset and zero folders. Copies the asset guid to the clipboard |

Outliner and Components `TreeView`s use **immediate** drag-to-parent (pointer move past 8px). Drop on the **middle** of a row nests under that row; the **top/bottom 8px** show a 1px insert line on that row only (not the neighbor) and insert as a **sibling** (`onReparent` `before` / `after`). If the dragged Outliner or Components row is in the current selection, the **collapsed** selection moves: omit descendants of a selected folder or transform/component parent so a parent+child pick cannot double-move or duplicate. Actors that live in a selected folder ride with the folder. Dragging an unselected row moves only that row. A selected Outliner drop that includes folder roots onto an **actor** row is a no-op. In-tree Outliner drops never duplicate actors. A **horizontal swipe ≥44px** on a row adds it to the selection and does not reparent. A **two-finger tap** range-selects from the current selection to that row. Outliner **Ctrl / Shift / Meta** click toggles folders and actors (no Shift-range on desktop). Exclusive folder tap still clears the actor selection so it cannot drive the gizmo. Outliner Duplicate / Delete live on a trailing **⋯** button (no 500ms row long-press). **Double-tap** an outliner row frames that actor (folder rows do not frame). Content Browser folder trees keep hold-to-drag so list scroll still works.

**Outliner actor → viewport:** the Outliner tree sets both `onReparent` and `onExternalDrop`. While the pointer is **outside** the tree, `GraphDropHint` (`outliner-drop-hint`) follows it — `+{actor.name}` over `viewport-canvas`, ban icon anywhere else. Drop on the canvas duplicates that one actor at the drop world position (new id, `{name} Copy`, root `parentId`, keep `folderId`; no children). Folders show the ban hint and do not duplicate. Releases **inside** the tree still reparent/group (table below). This is not Place Actors catalog drag-to-viewport.

Class members use the same pointer path (`TreeView.onExternalDrop`), not HTML5 drag-and-drop: mouse arms after 8px, touch after the ~250ms hold, and the drop fires only when the pointer is released **outside** the tree. Swipe-add does not apply on this tree. Dropping onto the Graph canvas spawns Call Custom Event / Call Function, or opens the Get/Set Dialog for variables.

In the Outliner the **drop target decides what a drag means**, because folders group and `parentId` attaches:

| Drag | Drop on | Result |
| --- | --- | --- |
| Actor | Folder row (middle) | Joins that folder; transform parent cleared |
| Actor | Before/after a folder row | Sibling of that folder (joins the folder's parent; not grouped into it). Folders still list above actors at a level |
| Actor | Actor row (middle) | Becomes that actor's transform child; inherits its folder |
| Actor | Before/after an actor row | Sibling with the same parent/folder; order is spliced. Not attached as a child |
| Actor | Empty space in the tree | Back to the scene root; folder and parent cleared |
| Actor | Scene viewport | Duplicate at the drop world position (root; keep folder) |
| Folder | Folder row (middle) | Nests (cycles rejected) |
| Folder | Before/after a folder row | Sibling of that folder; folder array order is spliced |
| Folder | Empty space | Back to the root |
| Folder | Actor row (middle) | No-op when that folder is in the selection; unselected folder unroots |
| Folder | Before/after an actor row | Joins the actor's folder as a sibling folder |
| Folder | Scene viewport | No-op (ban hint) |
| Multi-selection | Same targets | Collapsed roots only; actor count unchanged |
