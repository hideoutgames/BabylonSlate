---
node: physics.getAngularVelocity
---

# Get Physics Angular Velocity In Degrees

Returns how fast an actor's Rigid Body is spinning.

## Inputs

| Pin | Type | Description |
| --- | --- | --- |
| Target | Actor Reference | Left unconnected the pin shows **Self** and uses the actor running the graph. |

## Outputs

| Pin | Type | Description |
| --- | --- | --- |
| Angular Velocity | Vector3 | Degrees per second about each world axis. |

## Notes

- Returns a zero vector when the actor has no Rigid Body.
