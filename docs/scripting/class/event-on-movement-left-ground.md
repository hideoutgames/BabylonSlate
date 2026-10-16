# Event On Movement Left Ground

Runs when the actor's Movement component stops being on the ground.

## Outputs

| Pin | Type | Description |
| --- | --- | --- |
| Out | Exec |  |
| Velocity | Vector 3 | World velocity in units per second at the moment the event ran. |
| Speed | Float | Horizontal speed in units per second, ignoring vertical movement. |

## Notes

- Fires when the actor walks off an edge or jumps.
- Belongs to a **Movement** component on an Actor.
