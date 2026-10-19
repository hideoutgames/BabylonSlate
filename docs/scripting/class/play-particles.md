---
node: particles.play
---

# Play Particles

Starts the particle systems on an actor.

## Inputs

| Pin | Type | Description |
| --- | --- | --- |
| In | Exec |  |
| Actor | Actor Reference | The actor to play. Left unconnected the pin reads **Actor (Self)** and plays the actor running the graph. |

## Outputs

| Pin | Type |
| --- | --- |
| Out | Exec |

## Notes

- Plays every particle component on the actor.
- If **Actor** is connected to a reference that is empty when the node runs, nothing happens and an error is logged.
