---
node: particles.stop
---

# Stop Particles

Stops the particle systems on an actor from emitting.

## Inputs

| Pin | Type | Description |
| --- | --- | --- |
| In | Exec |  |
| Actor | Actor Reference | The actor to stop. Leave it unconnected to use the actor running the graph. |

## Outputs

| Pin | Type |
| --- | --- |
| Out | Exec |

## Notes

- Stops every particle component on the actor. Particles already in flight finish their lifetime.
