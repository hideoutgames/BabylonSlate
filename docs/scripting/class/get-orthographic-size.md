---
node: camera.getOrthographicSize
---

# Get Orthographic Size

Returns half the height of an orthographic camera's view, in world units.

## Inputs

| Pin | Type |
| --- | --- |
| Target | CameraComponent Reference |

## Outputs

| Pin | Type |
| --- | --- |
| Size | Float |

## Notes

- Only orthographic cameras use this value. Perspective cameras use their field of view.
- With [pixel-matched cameras](../../graphics/cameras.md#pixel-matched-cameras), it returns the half-height the camera shows over the design resolution, at the whole pixel scale the set size picks.
