---
node: render-target.setFieldOfView
---

# Set Capture Field Of View

Sets the field of view of a capture actor's camera, in degrees.

## Inputs

| Pin | Type |
| --- | --- |
| Exec | Exec |
| Capture | RenderTargetCapture Reference |
| Field Of View | Float |

## Outputs

| Pin | Type |
| --- | --- |
| Then | Exec |

## Notes

- Values are clamped to between 1 and 179 degrees.
