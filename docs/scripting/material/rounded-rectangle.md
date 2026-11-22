---
node: ui.roundedRectangle
---

# Rounded Rectangle

Returns masks for a rectangle with rounded corners, and the distance to its edge in pixels.

## Inputs

| Pin | Type | Default | Description |
| --- | --- | --- | --- |
| Position (Pixels) | Vector2 |  | The point to test, measured from the rectangle's bottom-left corner. When unconnected, uses the pixel's Element Position from [**User Interface Input**](user-interface-input.md). |
| Size (Pixels) | Vector2 |  | The width and height of the rectangle. When unconnected, uses the Element Size, so the rectangle fills the element. |
| Corner Radius (Pixels) | Vector4 | (8, 8, 8, 8) | The radius of each corner, in the order top left, top right, bottom right, bottom left. |
| Border Width (Pixels) | Float | 0 | How wide the border is, measured inward from the edge. |

## Outputs

| Pin | Type | Description |
| --- | --- | --- |
| Fill | Float | 1 inside the rectangle and 0 outside. |
| Border | Float | 1 on the border, a band of Border Width just inside the edge, and 0 elsewhere. 0 everywhere when Border Width is 0. |
| Distance (Pixels) | Float | The signed distance to the edge: negative inside, positive outside. |

## Notes

- Each corner radius is limited to half the shorter side, so a large radius makes a pill shape.
- Fill and Border are smoothed over one pixel at their edges, so the shape is antialiased at any size.
- For a rounded panel, multiply Fill into **Opacity** on [**User Interface Output**](user-interface-output.md).
- For a border in another colour, use [**Mix**](mix.md) with the fill colour as A, the border colour as B and Border as Alpha.
- Only in User Interface materials, in the fragment stage.
