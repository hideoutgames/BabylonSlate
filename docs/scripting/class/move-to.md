---
node: navigation.moveTo
---

# Move To

Sends an actor toward a destination along the navigation mesh.

## Inputs

| Pin | Type | Description |
| --- | --- | --- |
| In | Exec |  |
| Target | Actor Reference | Actor to move. It needs a Nav Agent component. |
| Destination | Vector 3 | World position to walk to. |

## Outputs

| Pin | Type |
| --- | --- |
| Out | Exec |

## Notes

- The actor needs a Nav Agent component, and the scene needs a baked navigation mesh; otherwise nothing happens.
- The node continues at once while the actor walks over the following frames. The destination snaps to the nearest point on the mesh.
- If **Target** is connected to a reference that is empty when the node runs, nothing happens.
