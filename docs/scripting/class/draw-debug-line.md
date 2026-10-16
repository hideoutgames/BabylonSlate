# Draw Debug Line

Draws a line between two world positions.

## Inputs

| Pin | Type | Description |
| --- | --- | --- |
| In | Exec |  |
| Start | Vector 3 |  |
| End | Vector 3 |  |
| Thickness | Float | Values above 1 draw a thicker line; 1 or less draws a thin line. |
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
