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
