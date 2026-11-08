---
node: physics.getLinearVelocity
---

# Get Physics Linear Velocity

Returns how fast an actor's Rigid Body is moving.

## Inputs

| Pin | Type | Description |
| --- | --- | --- |
| Target | Actor Reference | Left unconnected the pin shows **Self** and uses the actor running the graph. |

## Outputs

| Pin | Type | Description |
| --- | --- | --- |
| Velocity | Vector 3 | World units per second, at the body's centre of mass. |

## Notes

- Returns a zero vector when the actor has no Rigid Body.
