---
node: debug.drawCone
---

# Draw Debug Cone

Draws a wireframe cone from a tip point along a direction.

## Inputs

| Pin | Type | Description |
| --- | --- | --- |
| In | Exec |  |
| Origin | Vector 3 | Position of the cone's tip. |
| Direction | Vector 3 | Direction the cone points. A zero vector points it up. |
| Length | Float | Distance from the tip to the circular base, in world units. |
| Angle | Float | Half-angle at the tip in degrees. Limited to 0 to 89. |
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
