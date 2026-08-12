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

Inputs, textareas, `contenteditable` and anything inside `SelectableText` keep the platform menu, since that is where cut/copy/paste is still wanted.

### iOS three-finger undo/redo

iOS 13+ standalone / Add to Home Screen maps three-finger swipe and tap to system undo/redo. That fights the viewport pan gesture and delays `pointermove` while the recognizer decides.

- `useSuppressIosEditingGestures` (applied once at the shell) `preventDefault`s 3+ finger `touchstart`/`touchmove` and `beforeinput` `historyUndo`/`historyRedo` document-wide.
- Inputs, textareas, `contenteditable`, and `SelectableText` keep system typing undo.
- Editor canvases (scene and Prefab Preview) also `preventDefault` every `touchstart`/`touchmove` with a non-passive listener so iOS does not hold pointer events for gesture recognition. The canvas already uses `touch-none` and does not scroll.

Do not bind Cmd+Z to document undo without ignoring events while a three-pointer viewport gesture is active.

### Cancellation

`useContextMenu` cancels a pending long-press when the pointer moves past 8px or on scroll (captured document-wide, since `scroll` does not bubble). The 500ms delay and 8px tolerance deliberately match Dockview's `LongPressDetector` defaults, so a panel drag and a context menu can never both fire from one gesture.

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

## Virtual keyboard

Focusing a text field on iPad raises the keyboard and can cover a centered modal. `CatalogDialog` search is **not** autofocused on open (`initialFocus` is the scrollable body; `autoFocusSearch` defaults to false). That includes Add Node, Place Actors, Add Component, and Settings. Global Search may autofocus because it is a search-first UI with no category list.

## Dockview

- Dockview 8's `dndStrategy` defaults to `'auto'`: HTML5 drag for mouse, pointer events for touch and pen. Touch panel drag therefore needs no extra configuration.
- Tab strips are **26px on coarse pointers** and **18px on fine pointers**; grips stay 44px+. Editor chrome and panel headers use `--chrome-row` (28px).
- Sashes stay visually thin (4px) but carry a widened hit area via a transparent pseudo-element, because Dockview sizes the sash element itself from an internal constant that CSS cannot override.
- Panel **content** is a gesture-safe zone — viewport and graph handle their own gestures.
- No popout / floating groups on iOS/Android.

## Viewport (Babylon)

- **One finger**: tap to pick/select. In **3D**, drag looks in place (yaw/pitch; camera position stays put). In **2D**, drag **marquees** (actors whose origin falls inside the rect). Gizmo handle hits skip look so transform drags still win.
- **Pinch** (two fingers, spread change) zooms / dollies. Two-finger translation does not orbit or pan.
- **Three fingers** pan (move the camera).
- **WASD** flies in 3D (look-relative) and pans on XY in 2D. Ignored while typing, while Play is open, or when the canvas is hidden.
- **Editor camera joystick** (`settings.editorJoystickEnabled`) is an optional on-screen stick that drives the same fly/pan path. Not the P9 game `TouchJoystick`.
- **Gizmo drag** coalesces to one undo step via `mergeKey` on `SetActorTransformCommand` (`transform:{actorId}`).
- Canvas uses `touch-none` plus non-passive touch `preventDefault` so UI chrome and iOS system gestures do not steal look / pinch / pan.
- Selection on explicit tap pick, not hover.

## Graph (React Flow)

- One-finger pan/zoom inside graph panel only.
- **Tap-to-connect:** tap an output pin, then an input pin (primary mobile path; shipped in `p5-graph-ui`). Pin hit boxes are `--touch-target` (44px); visual pins are `--graph-pin-size` (16px). Wires use `--pin-*` colors and 4–5px strokes.
- **Drag-to-connect:** allowed by the gesture contract; deferred as polish (see issue-tracker P5 follow-ups).
- Node palette is a centered `CatalogDialog` (search **not** autofocused); long-press / secondary click for node context menus when enabled.

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
| Tap / click a tile | Select (replace selection) |
| Double-tap / double-click a Scene or Graph | Open the document (`openOrFocusDocument`) |
| Long-press / right-click | Context menu (move, rename, duplicate, delete, …) |
