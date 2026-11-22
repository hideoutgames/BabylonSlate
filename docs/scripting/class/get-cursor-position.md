---
node: input.getCursorPosition
---

# Get Cursor Position

Returns the pointer position over the game view.

## Outputs

| Pin | Type | Description |
| --- | --- | --- |
| Position | Vector2 |  |
| Pressed | Boolean | True while the left mouse button is down or a finger touches the view. |

## Notes

- Position is in pixels from the top-left corner of the game view, as the browser lays out the page: on a high-density screen such as an iPad's, one of these pixels covers two or more of the display's own. Resolution Scale and upscaling do not change it. [Get Viewport Size](get-viewport-size.md) returns the view's size in the same pixels.
- Touch uses the first finger. The last position is kept after the pointer lifts.
- To read every finger, use [Get Touch](get-touch.md) or the touch events such as [Event On Touch Began](event-on-touch-began.md).
