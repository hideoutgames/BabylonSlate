# Find Path To

Finds a walkable route between two points on the navigation mesh.

## Inputs

| Pin | Type |
| --- | --- |
| In | Exec |
| From | Vector 3 |
| To | Vector 3 |

## Outputs

| Pin | Type |
| --- | --- |
| Out | Exec |
| Path | Array of Vector 3 |

## Notes

- **Path** lists the corner points from **From** to **To**. It is empty when no route exists, or when a point is more than 4 units from the mesh.
- Needs a baked navigation mesh in the current scene; use **Bake NavMesh** in the NavMesh actor's **Inspector**.
