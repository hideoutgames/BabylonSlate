# Draw Debug Rectangle

Draws a rectangle outline at a world position.

## Inputs

| Pin | Type | Description |
| --- | --- | --- |
| In | Exec |  |
| Center | Vector 3 |  |
| Width | Float | Size along the rectangle's X axis, in world units. |
| Height | Float | Size along the rectangle's Y axis, in world units. |
| Rotation | Rotator | Orientation in degrees (pitch, yaw, roll). |
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
- The rectangle lies flat in the X-Y plane before **Rotation** is applied.
