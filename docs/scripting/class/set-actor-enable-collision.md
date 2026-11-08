---
node: physics.setActorEnableCollision
---

# Set Actor Enable Collision

Turns all of an actor's collision off, or back on.

## Inputs

| Pin | Type | Description |
| --- | --- | --- |
| In | Exec |  |
| Target | Actor Reference | Left unconnected the pin shows **Self** and uses the actor running the graph. |
| Enabled | Boolean | On by default. |

## Outputs

| Pin | Type |
| --- | --- |
| Out | Exec |

## Notes

- While collision is off, none of the actor's colliders block or overlap anything, and traces and overlap queries pass through the actor.
- The actor's Rigid Body keeps simulating, so a Dynamic body without collision falls through the floor.
- Collision is on again for every actor when Play starts.
