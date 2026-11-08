---
node: camera.playShakeOnSceneLayer
---

# Play Camera Shake On Scene Layer

Shakes a Scene Layer's own view with a Camera Shake asset.

## Inputs

| Pin | Type | Description |
| --- | --- | --- |
| In | Exec |  |
| Scene Layer | SceneLayer Reference | The Scene Layer whose view shakes, such as **Get Owning Scene Layer**. |
| Shake | CameraShake Asset | The [Camera Shake](../../assets/camera-shake.md) to play. |
| Scale | Float | Multiplies the shake's strength. Defaults to 1; 0 or below plays nothing. |

## Outputs

| Pin | Type |
| --- | --- |
| Out | Exec |
| Handle | CameraShakeHandle |

## Notes

- Only that Scene Layer's picture moves; touches and clicks still hit its controls where they are.
- The shake ends when the Scene Layer is removed.
