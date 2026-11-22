---
node: input.ui
---

# User Interface Input

Returns where the current pixel sits on the element being drawn and on the screen, in 0 to 1 coordinates and in pixels.

## Outputs

| Pin | Type | Description |
| --- | --- | --- |
| Element UV | Vector2 | Where the pixel sits on the element, from 0 to 1 on each axis. |
| Element Size (Pixels) | Vector2 | The width and height of the element in pixels. |
| Element Position (Pixels) | Vector2 | Where the pixel sits on the element, in pixels: Element UV times Element Size. |
| Screen UV | Vector2 | Where the pixel sits on the screen, from 0 to 1 on each axis, as [**Screen UV**](screen-uv.md) returns. |
| Screen Size (Pixels) | Vector2 | The width and height of the screen in pixels, as [**Screen Size**](screen-size.md) returns. |
| Screen Position (Pixels) | Vector2 | Where the pixel sits on the screen, in pixels. |

## Notes

- Coordinates start at the bottom left: (0, 0) is the element's bottom-left corner, and Element UV (1, 1) its top-right corner.
- Pixels are pixels of what the element is drawn into: the screen in Play, and the **Preview** window in the Material editor.
- Element Size follows the element's size on screen, so it changes with the screen's resolution and the layer's scaling. Shapes built on it in pixels, such as a corner radius, keep their size in pixels.
- In a 2D control, each part (such as a slider's track, fill and thumb) is its own element with its own Element UV and Element Size. A 2D Panel's Material spans the whole panel.
- Only in User Interface materials, in the fragment stage.
