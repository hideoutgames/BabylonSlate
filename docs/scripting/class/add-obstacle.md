# Add Obstacle

Blocks part of the navigation mesh with an unwalkable box or cylinder.

## Inputs

| Pin | Type | Description |
| --- | --- | --- |
| In | Exec |  |
| Kind | NavObstacleKind | Box or Cylinder. Defaults to Box. |
| Pose | Vector 3 | Centre of the volume, in world units. |
| Size | Vector 3 | Full extent of the volume along each axis. |

## Outputs

| Pin | Type | Description |
| --- | --- | --- |
| Out | Exec |  |
| ID | String | Identifier to pass to [**Remove Obstacle**](remove-obstacle.md). |

## Notes

- Pose is the centre of the volume and Size is its full extent. A cylinder takes its diameter from X and Z and its height from Y.
- Works only when the scene's navigation mesh was baked with **Support Dynamic Obstacles**, and holds up to 128 obstacles at a time.
- **ID** is empty when nothing was carved.
