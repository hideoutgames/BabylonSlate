---
node: physics.setAngularVelocity
---

# Set Physics Angular Velocity In Degrees

Sets how fast an actor's Rigid Body spins.

## Inputs

| Pin | Type | Description |
| --- | --- | --- |
| In | Exec |  |
| Target | Actor Reference | Left unconnected the pin shows **Self** and uses the actor running the graph. |
| Angular Velocity | Vector 3 | Degrees per second about each world axis. |
| Add To Current | Boolean | Adds **Angular Velocity** to the current spin instead of replacing it. |

## Outputs

| Pin | Type |
| --- | --- |
| Out | Exec |

## Notes

- Only a Rigid Body whose motion type is Dynamic spins by its angular velocity.
- In a 2D project only the Z value turns the body.
