# Is Path Valid

Checks whether a walkable route exists between two points.

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
| Valid | Boolean |

## Notes

- **Valid** is false when no route exists, or when a point is more than 4 units from the mesh.
- Needs a baked navigation mesh in the current scene; use **Bake NavMesh** in the NavMesh actor's **Inspector**.
