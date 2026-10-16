# Event On Movement Started

Runs when the actor's Movement component starts moving horizontally.

## Outputs

| Pin | Type | Description |
| --- | --- | --- |
| Out | Exec |  |
| Velocity | Vector 3 | World velocity in units per second at the moment the event ran. |
| Speed | Float | Horizontal speed in units per second, ignoring vertical movement. |

## Notes

- Fires when horizontal speed rises above a small threshold. Falling or rising alone does not count.
- Belongs to a **Movement** component on an Actor.
