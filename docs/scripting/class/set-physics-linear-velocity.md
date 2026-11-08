---
node: physics.setLinearVelocity
---

# Set Physics Linear Velocity

Sets how fast an actor's Rigid Body moves.

## Inputs

| Pin | Type | Description |
| --- | --- | --- |
| In | Exec |  |
| Target | Actor Reference | Left unconnected the pin shows **Self** and uses the actor running the graph. |
| Velocity | Vector 3 | World units per second. |
| Add To Current | Boolean | Adds **Velocity** to the body's current velocity instead of replacing it. |

## Outputs

| Pin | Type |
| --- | --- |
| Out | Exec |

## Notes

- Only a Rigid Body whose motion type is Dynamic moves by its velocity.
- Gravity, damping and collisions keep acting on the body afterwards.
