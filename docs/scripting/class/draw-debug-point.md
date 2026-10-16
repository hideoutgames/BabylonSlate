# Draw Debug Point

Draws a small three-axis cross at a world position.

## Inputs

| Pin | Type | Description |
| --- | --- | --- |
| In | Exec |  |
| Position | Vector 3 |  |
| Size | Float | Overall width of the cross in world units. |
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
