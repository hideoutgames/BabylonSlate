---
node: flow.event.movementJumped
---

# Event On Movement Jumped

Runs when the actor's Movement component starts a jump.

## Outputs

| Pin | Type | Description |
| --- | --- | --- |
| Out | Exec |  |
| Velocity | Vector 3 | World velocity in units per second at the moment the event ran. |
| Speed | Float | Horizontal speed in units per second, ignoring vertical movement. |

## Notes

- Fires on the step the jump is applied. A jump from the ground also runs [**Event On Movement Left Ground**](event-on-movement-left-ground.md).
- Belongs to a **Movement** component on an Actor.
