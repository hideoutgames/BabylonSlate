---
node: camera.resumeShake
---

# Resume Camera Shake

Lets a paused camera shake play on.

## Inputs

| Pin | Type | Description |
| --- | --- | --- |
| In | Exec |  |
| Handle | CameraShakeHandle | The shake's handle from a Play Camera Shake node. |

## Outputs

| Pin | Type |
| --- | --- |
| Out | Exec |

## Notes

- The shake continues from where it was paused.
- A handle whose shake has ended does nothing.
