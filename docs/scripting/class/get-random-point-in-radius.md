# Get Random Point In Radius

Picks a random walkable point within a radius of a position.

## Inputs

| Pin | Type | Description |
| --- | --- | --- |
| In | Exec |  |
| Center | Vector 3 |  |
| Radius | Float | Search distance in world units. |

## Outputs

| Pin | Type |
| --- | --- |
| Out | Exec |
| Point | Vector 3 |
| Found | Boolean |

## Notes

- **Found** is false when the centre is more than 4 units from the mesh or no point could be picked. **Point** is then the zero vector.
- Needs a baked navigation mesh in the current scene; use **Bake NavMesh** in the NavMesh actor's **Inspector**.
