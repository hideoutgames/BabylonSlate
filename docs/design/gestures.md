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
| CSS | `overscroll-behavior: contain` on intentional scroll regions | Content browser, chrome tab strip, homepage body |
| JS | `usePreventDocumentOverscroll` — `touchmove` guard on coarse pointers | iOS Safari / touch fallback |
| Native | WKWebView `scrollView.bounces = false` | Capacitor iOS app only |

### Standalone (Add to Home Screen)

`apps/editor/index.html` sets `viewport-fit=cover` plus `apple-mobile-web-app-capable` / `mobile-web-app-capable` so a Pages home-screen app is fullscreen and does not resize-churn on the home indicator. The three-finger undo suppression above must ship with those tags; capable meta otherwise makes iOS editing gestures more aggressive.

### Regions that still scroll internally

- Homepage `<main>` — project list and create cards
- Chrome tab strip — horizontal overflow
- Content browser — folder tree and asset grid
- Graph panel — React Flow pan/zoom (unchanged)
- Global Search results (`global-search-results`) — overflow list inside a fixed-height dialog

## Virtual keyboard

Focusing a text field on iPad raises the keyboard and can cover a centered modal. `CatalogDialog` search is **not** autofocused on open (`initialFocus` is the scrollable body; `autoFocusSearch` defaults to false). That includes Add Node, Place Actors, Add Component, and Settings. Global Search may autofocus because it is a search-first UI with no category list.

## Dockview

- Dockview 8's `dndStrategy` defaults to `'auto'`: HTML5 drag for mouse, pointer events for touch and pen. Touch panel drag therefore needs no extra configuration.
- Tab strips are **26px on coarse pointers** and **18px on fine pointers**; grips stay 44px+. Editor chrome and panel headers use `--chrome-row` (28px).
- Sashes stay visually thin (4px) but carry a widened hit area via a transparent pseudo-element, because Dockview sizes the sash element itself from an internal constant that CSS cannot override.
- Panel **content** is a gesture-safe zone — viewport and graph handle their own gestures.
- No popout / floating groups on iOS/Android.

## Viewport (Babylon)

- **One finger**: tap to pick/select. In **3D**, drag looks in place (yaw/pitch; camera position stays put). In **2D**, drag **pans** 1:1 with the pointer (the world point under the finger stays put; same scale/axes as three-finger pan). **Hold ~250ms then move** marquees in 2D (actors whose origin falls inside the rect). **Drag Select** (viewport toolbar) hijacks the next one-finger drag in 2D and 3D: no pan/look, live overlay, commit on release, then the tool unpresses. Gizmo handle hits skip look/pan so transform drags still win, except while Drag Select is armed. A pointer-up that started on a gizmo is not a pick — releasing a handle must not clear the selection.
- **Pinch** (two fingers, spread change) zooms / dollies. Two-finger translation does not orbit or pan. 2D pinch and wheel are continuous, including when pixel-perfect integer zoom steps is on.
- **Three fingers** pan (move the camera). In 2D this is the same 1:1 frustum / CSS-pixel mapping as one-finger pan; in 3D it uses a fixed world-units-per-pixel scale.
- **WASD** flies in 3D (look-relative) and pans on XY in 2D. Ignored while typing, while Play is open, or when the canvas is hidden.
- **Editor camera joystick** (`settings.editorJoystickEnabled`) is an optional on-screen stick that drives the same fly/pan path. Scene and Prefab **Viewport Settings** menus expose Snap, Show Grid, and Joystick; Scene persists those settings, Prefab uses live context. Not the P9 game `TouchJoystick`.
- **Gizmo drag** coalesces to one undo step: `SetActorTransformCommand` (`transform:{actorId}`) for one actor, `SetActorsTransformsCommand` (`transforms:{sortedIds}`) when several selection roots move together.
- Canvas uses `touch-none` plus non-passive touch `preventDefault` so UI chrome and iOS system gestures do not steal look / pinch / pan.
- Selection on explicit tap pick, not hover.

## Graph (React Flow)

- One-finger pan/zoom inside graph panel only. Zoom-out floor is 10% (`GRAPH_MIN_ZOOM` 0.1); zoom-in ceiling is 1.5. **Tap empty pane** clears selection. **Hold empty pane ~250ms, then move** marquees via a custom overlay (`attachGraphPaneMarquee`; do not steal one-finger pan until the hold arms). Once armed, mouse/touch pan events are swallowed and XYFlow `panOnDrag` is turned off so the overlay can select. XYFlow `selectionOnDrag` is not used — it cannot convert a gesture that already started as a pan.
- **Tap-to-connect:** tap an output pin, then an input pin (primary mobile path; shipped in `p5-graph-ui`). Pin hit boxes are `--touch-target` (44px); visual pins are `--graph-pin-size` (22px). Wires use `--pin-*` colors and 4–5px strokes.
- **Drag-to-connect:** shipped. React Flow `onConnect` / `isValidConnection` persist the same `addEdge` path as tap-to-connect. Connection preview uses the dragged pin’s color. `onConnectEnd` on empty pane opens Add Node only when the pointer is **outside a 96px screen-space safe zone** around the **source pin** and **compatible opposite pins**, and is not over a node body (`connectEndMode="default"`: script, material, anim). Behaviour trees pass `connectEndMode="add-node"`: a drag off a handle opens Add Node even when short, never breaks structural edges, and still cancels when the pointer is over a node or snapped handle. **Context Sensitive** (default ON) pin-filters that menu; off shows the host-legal catalog. While the drop would open Add Node, a non-interactive **Add Node** badge floats beside the moving wire end (not a persistent FAB). Releasing a dragged pin without snapping a handle and without opening Add Node **breaks all wires on that pin** in default mode. A tap or drop that stays on the source handle does not disconnect (tap-to-connect still works). Dismissing Add Node without picking a node also leaves existing wires. Behaviour trees also open Add Node from a pending pin plus empty-pane tap. **Exec** pins allow multiple incoming and outgoing wires (flow merge / fan-out). **Data inputs** take one wire; connecting a second source **replaces** the previous. Data outputs still fan out to many inputs.
- **Double-tap empty pane** opens Add Node with all **host-legal** nodes (not the whole engine catalog) unless the host sets `emptyPaneDoubleTapAddsNode={false}`. Search and category reset on every open. There is no persistent floating Add node button.
- Overlay toolbar: Copy / Paste / Delete on the selection; **Break Links** drops every incident wire on selected nodes (nodes stay); **Format** tidies selected nodes, or walks the exec then-chain to the right of a single impure selection and lays out data-input trees (pure nodes) to the left of those nodes. A selected pure node walks data-out instead, stacking parallel data branches on their own path. Behaviour Tree hides Copy, Paste, Break Links, and Format, and adds **Auto Arrange**.
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
| Left tree: double-tap asset | Open the asset |
| Left tree: hold ~250ms then drag | Reparent (`moveAsset` / `moveFolder`). Pointer capture waits until that hold arms; rows are not `touch-none`, so early movement still scrolls. No context menu on the tree. Root `assets` is not draggable. |
| Context-menu **Move…** / **Copy to Folder…** | Opens `ContentBrowserMoveDialog` for the whole selection (`moveAsset` / `copyAsset` / `moveFolder` / `copyFolder`) |

Outliner, Components, and UserInterface hierarchy `TreeView`s use **immediate** drag-to-parent (pointer move past 8px; drop on a row makes that row the parent). Outliner Duplicate / Delete and UserInterface Visible / Ignore Safe Area / Duplicate / Rename / Delete live on a trailing **⋯** button (no 500ms row long-press). **Double-tap** an outliner row frames that actor (folder rows do not frame). Content Browser folder trees keep hold-to-drag so list scroll still works.

Class members use the same pointer path (`TreeView.onExternalDrop`), not HTML5 drag-and-drop: mouse arms after 8px, touch after the ~250ms hold, and the drop fires only when the pointer is released **outside** the tree. Dropping onto the Graph canvas spawns Call Custom Event / Call Function, or opens the Get/Set Dialog for variables.

In the Outliner the **drop target decides what a drag means**, because folders group and `parentId` attaches:

| Drag | Drop on | Result |
| --- | --- | --- |
| Actor | Folder row | Joins that folder; transform parent cleared |
| Actor | Actor row | Becomes that actor's transform child; inherits its folder |
| Actor | Empty space | Back to the scene root; folder and parent cleared |
| Folder | Folder row | Nests (cycles rejected) |
| Folder | Empty space | Back to the root |
