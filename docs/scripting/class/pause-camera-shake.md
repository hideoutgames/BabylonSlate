---
node: camera.pauseShake
---

# Pause Camera Shake

Holds a camera shake where it is.

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

- The view stays where the shake has moved it until [**Resume Camera Shake**](resume-camera-shake.md).
- A handle whose shake has ended does nothing.
