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

### Regions that still scroll internally

- Homepage `<main>` — project list and create cards
- Chrome tab strip — horizontal overflow
- Content browser — folder tree and asset grid
- Graph panel — React Flow pan/zoom (unchanged)

## Dockview

- Dockview 8's `dndStrategy` defaults to `'auto'`: HTML5 drag for mouse, pointer events for touch and pen. Touch panel drag therefore needs no extra configuration.
- Tab strips are **52px on coarse pointers** and a compact **36px strip on fine pointers**; grips stay 44px+.
- Sashes stay visually thin (4px) but carry a widened hit area via a transparent pseudo-element, because Dockview sizes the sash element itself from an internal constant that CSS cannot override.
- Panel **content** is a gesture-safe zone — viewport and graph handle their own gestures.
- No popout / floating groups on iOS/Android.

## Viewport (Babylon)

- **One finger** manipulates content: tap to pick/select; in **2D mode**, drag to **marquee** (actors whose origin falls inside the rect). Single-finger drag has no meaning in 3D.
- **Two fingers** orbit (3D), pan, and pinch-zoom on canvas; 2D mode is pan + zoom only (no orbit).
- **Gizmo drag** coalesces to one undo step via `mergeKey` on `SetActorTransformCommand` (`transform:{actorId}`).
- Canvas uses `touch-none` so UI chrome does not steal gestures.
- Selection on explicit tap pick, not hover.

## Graph (React Flow)

- One-finger pan/zoom inside graph panel only.
- **Tap-to-connect:** tap an output pin, then an input pin (primary mobile path; shipped in `p5-graph-ui`).
- **Drag-to-connect:** allowed by the gesture contract; deferred as polish (see issue-tracker P5 follow-ups).
- Node palette is a bottom sheet; long-press / secondary click for node context menus when enabled.

## Document tabs (chrome bar)

| Gesture | Action |
| --- | --- |
| Quick horizontal swipe on tab strip | Scroll overflow tabs |
| Tap tab label | Select tab |
| Tap close | Close tab |
| Long-press (~300 ms, stationary) on tab, then drag horizontally | Reorder tab (dnd-kit); distinct from Dockview panel drag |
