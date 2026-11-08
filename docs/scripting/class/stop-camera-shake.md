---
node: camera.stopShake
---

# Stop Camera Shake

Stops a playing camera shake.

## Inputs

| Pin | Type | Description |
| --- | --- | --- |
| In | Exec |  |
| Handle | CameraShakeHandle | The shake's handle from a Play Camera Shake node. |
| Immediately | Boolean | Stops it at once instead of blending it out. Off by default. |

## Outputs

| Pin | Type |
| --- | --- |
| Out | Exec |

## Notes

- Without **Immediately** the shake fades over its asset's **Blend Out Time**.
- A handle whose shake has ended does nothing.
