---
node: ui.ellipse
---

# Ellipse

Returns masks for the ellipse that fits inside a rectangle, and the distance to its edge in pixels.

## Inputs

| Pin | Type | Default | Description |
| --- | --- | --- | --- |
| Position (Pixels) | Vector2 |  | The point to test, measured from the bottom-left corner of the rectangle around the ellipse. When unconnected, uses the pixel's Element Position from [**User Interface Input**](user-interface-input.md). |
| Size (Pixels) | Vector2 |  | The width and height of the ellipse. When unconnected, uses the Element Size, so the ellipse fills the element. |
| Border Width (Pixels) | Float | 0 | How wide the border is, measured inward from the edge. |

## Outputs

| Pin | Type | Description |
| --- | --- | --- |
| Fill | Float | 1 inside the ellipse and 0 outside. |
| Border | Float | 1 on the border, a band of Border Width just inside the edge, and 0 elsewhere. 0 everywhere when Border Width is 0. |
| Distance (Pixels) | Float | The signed distance to the edge: negative inside, positive outside. |

## Notes

- With equal width and height it is a circle. On a square element, leave Size unconnected for a circle that fills it.
- Fill and Border are smoothed over one pixel at their edges, so the shape is antialiased at any size.
- For a round button or joystick, multiply Fill into **Opacity** on [**User Interface Output**](user-interface-output.md).
- For a ring in another colour, use [**Mix**](mix.md) with the fill colour as A, the ring colour as B and Border as Alpha.
- Only in User Interface materials, in the fragment stage.
