# Get Closest Navigable Point

Finds the point on the navigation mesh nearest to a position.

## Inputs

| Pin | Type |
| --- | --- |
| In | Exec |
| Point | Vector 3 |

## Outputs

| Pin | Type |
| --- | --- |
| Out | Exec |
| Closest | Vector 3 |
| Found | Boolean |

## Notes

- **Found** is false when no part of the mesh lies within 4 units of the point. **Closest** is then the zero vector.
- Needs a baked navigation mesh in the current scene; use **Bake NavMesh** in the NavMesh actor's **Inspector**.
