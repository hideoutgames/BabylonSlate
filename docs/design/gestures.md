# Touch and gestures

BabylonSlate is touch-first. Do not assume hover or right-click.

## Global chrome

| Gesture | Target | Action |
| --- | --- | --- |
| Long-press (~500 ms, stationary) | Dockview tab/header chrome | Drag panel |
| Long-press (~500 ms, stationary) | Panel content (when menu enabled) | App context menu |
| Tap | Buttons, tabs, list items | Primary action |
| `contextmenu` | Desktop secondary click | Same as long-press menu |

- Native callout suppressed: `-webkit-touch-callout: none` on shell.
- Long-press cancels on scroll or when drag arms.

## Dockview

- Tab strips and sashes: enlarged hit areas (44px+).
- Panel **content** is a gesture-safe zone — viewport and graph handle their own gestures.
- No popout / floating groups on iOS/Android.

## Viewport (Babylon)

- Two-finger orbit and pinch on canvas.
- Canvas uses `touch-none` so UI chrome does not steal gestures.
- Selection on explicit tap pick, not hover.

## Graph (React Flow)

- One-finger pan/zoom inside graph panel only.

## Document tabs (chrome bar)

- Long-press on grip to reorder (dnd-kit); distinct from Dockview panel drag.
