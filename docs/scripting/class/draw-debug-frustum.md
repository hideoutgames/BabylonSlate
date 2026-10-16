# Draw Debug Frustum

Draws a camera view frustum from a position and rotation.

## Inputs

| Pin | Type | Description |
| --- | --- | --- |
| In | Exec |  |
| Origin | Vector 3 |  |
| Rotation | Rotator | Orientation in degrees (pitch, yaw, roll). |
| FOV | Float | Vertical field of view in degrees. Limited to 1 to 179. |
| Aspect | Float | Width divided by height. Defaults to 16:9. |
| Near | Float | Distance from Origin to the near plane, in world units. |
| Far | Float | Distance from Origin to the far plane, in world units. |
| Color | Color | Line colour. Alpha is ignored. Defaults to white. |
| Duration | Float | Seconds the shape stays visible. 0 shows it for one simulation tick, so call the node every tick to keep it on screen. |

## Outputs

| Pin | Type |
| --- | --- |
| Out | Exec |

## Settings

| Setting | Description |
| --- | --- |
| Development Only | On by default. Turn it off to keep the node in exported games. |

## Notes

- Draws in world space while the game runs, and is skipped in exported games unless you turn off **Development Only** in the **Inspector**.
