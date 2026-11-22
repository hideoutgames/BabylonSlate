---
node: system.getViewportSize
---

# Get Viewport Size

Returns the size of the game view.

## Outputs

| Pin | Type | Description |
| --- | --- | --- |
| Size | Vector2 | Width and height in pixels. |
| Aspect Ratio | Float | Width divided by height, such as 1.78 for a 16:9 view. |

## Notes

- Uses the same pixels as [**Get Cursor Position**](get-cursor-position.md) and the touch nodes, counted from the top-left corner: the page's layout pixels, not the display's own, so an iPad's view reports half its device resolution. Resolution Scale and upscaling do not change it.
- Changes when the window resizes or the device rotates.
- Returns 0 for both until the game view has a size, for example in the first moments of Play.
