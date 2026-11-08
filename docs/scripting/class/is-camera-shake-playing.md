---
node: camera.isShakePlaying
---

# Is Camera Shake Playing

Returns whether a camera shake is still playing.

## Inputs

| Pin | Type | Description |
| --- | --- | --- |
| Handle | CameraShakeHandle | The shake's handle from a Play Camera Shake node. |

## Outputs

| Pin | Type |
| --- | --- |
| Playing | Boolean |

## Notes

- True from Play until the shake ends or is stopped, including while it is paused or blending out.
