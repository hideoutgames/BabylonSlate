---
node: camera.playWorldShake
---

# Play World Camera Shake

Shakes the view more the closer it is to a point, as an explosion would.

## Inputs

| Pin | Type | Description |
| --- | --- | --- |
| In | Exec |  |
| Shake | CameraShake Asset | The [Camera Shake](../../assets/camera-shake.md) to play. |
| Epicenter | Vector3 | Where the shake comes from, in world space. |
| Inner Radius | Float | Within this distance the shake is at full strength. Defaults to 0. |
| Outer Radius | Float | Beyond this distance there is no shake. Defaults to 10. |
| Falloff | Float | How quickly the strength drops between the radii: 1 is even, higher fades faster near the inner radius. Defaults to 1. |

## Outputs

| Pin | Type |
| --- | --- |
| Out | Exec |
| Handle | CameraShakeHandle |

## Notes

- The distance is measured each frame from the camera in view, so moving away softens the shake.
- When the Layer Camera is in view, its centre on the XY plane is used.
