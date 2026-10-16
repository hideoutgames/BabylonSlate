---
node: flow.event.movementStopped
---

# Event On Movement Stopped

Runs when the actor's Movement component stops moving horizontally.

## Outputs

| Pin | Type | Description |
| --- | --- | --- |
| Out | Exec |  |
| Velocity | Vector 3 | World velocity in units per second at the moment the event ran. |
| Speed | Float | Horizontal speed in units per second, ignoring vertical movement. |

## Notes

- Fires when horizontal speed falls back to the small threshold or below. Vertical movement is ignored.
- Belongs to a **Movement** component on an Actor.
