---
node: camera.setShakeScale
---

# Set Camera Shake Scale

Changes how strongly a playing camera shake moves the view.

## Inputs

| Pin | Type | Description |
| --- | --- | --- |
| In | Exec |  |
| Handle | CameraShakeHandle | The shake's handle from a Play Camera Shake node. |
| Scale | Float | 0 holds the view still; 2 doubles the shake. Defaults to 1. |

## Outputs

| Pin | Type |
| --- | --- |
| Out | Exec |

## Notes

- A handle whose shake has ended does nothing.
