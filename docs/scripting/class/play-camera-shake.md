---
node: camera.playShake
---

# Play Camera Shake

Shakes the player's view with a Camera Shake asset.

## Inputs

| Pin | Type | Description |
| --- | --- | --- |
| In | Exec |  |
| Shake | CameraShake Asset | The [Camera Shake](../../assets/camera-shake.md) to play. |
| Scale | Float | Multiplies the shake's strength. Defaults to 1; 0 or below plays nothing. |

## Outputs

| Pin | Type |
| --- | --- |
| Out | Exec |
| Handle | CameraShakeHandle |

## Notes

- The shake follows the view: it keeps shaking when [**Possess Camera**](possess-camera.md) switches cameras, and during a blend.
- It ends after the asset's **Duration**, or, with Duration 0, when [**Stop Camera Shake**](stop-camera-shake.md) stops it.
- Several shakes add together. The camera actor itself never moves.
- Keep **Handle** to pause, scale or stop the shake.
