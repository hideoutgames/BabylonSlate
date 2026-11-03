---
node: particles.play
---

# Play Particles

Starts the particle systems on an actor.

## Inputs

| Pin | Type | Description |
| --- | --- | --- |
| In | Exec |  |
| Actor | Actor Reference | The actor to play. Left unconnected the pin shows **Self** and plays the actor running the graph. |

## Outputs

| Pin | Type |
| --- | --- |
| Out | Exec |

## Notes

- Plays every particle component on the actor. While an effect is still on screen, its **Retrigger** setting decides whether the earlier run finishes (**Overlap**) or is cut (**Restart**).
- If **Actor** is connected to a reference that is empty when the node runs, nothing happens and an error is logged.
