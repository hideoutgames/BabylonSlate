# Event On Movement Landed

Runs when the actor's Movement component touches the ground after being airborne.

## Outputs

| Pin | Type | Description |
| --- | --- | --- |
| Out | Exec |  |
| Velocity | Vector 3 | World velocity in units per second at the moment the event ran. |
| Speed | Float | Horizontal speed in units per second, ignoring vertical movement. |

## Notes

- Fires on the step the actor is grounded again.
- Belongs to a **Movement** component on an Actor.
