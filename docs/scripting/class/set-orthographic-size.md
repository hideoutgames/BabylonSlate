# Set Orthographic Size

Sets half the height of an orthographic camera's view, in world units.

## Inputs

| Pin | Type |
| --- | --- |
| In | Exec |
| Target | CameraComponent Reference |
| Size | Float |

## Outputs

| Pin | Type |
| --- | --- |
| Out | Exec |

## Notes

- A larger size shows more of the scene. The width follows the aspect ratio of the view.
- Only orthographic cameras use this value. Perspective cameras use their field of view.
