# Get Field Of View

Returns a camera's field of view in degrees.

## Inputs

| Pin | Type |
| --- | --- |
| Target | CameraComponent Reference |

## Outputs

| Pin | Type |
| --- | --- |
| FOV | Float |

## Notes

- Only perspective cameras use the field of view. Orthographic cameras use their orthographic size, which [**Get Orthographic Size**](get-orthographic-size.md) returns.
