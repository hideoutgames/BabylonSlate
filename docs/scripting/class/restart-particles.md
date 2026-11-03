---
node: particles.restart
---

# Restart Particles

Cuts the particles on an actor and plays its particle systems again from the start.

## Inputs

| Pin | Type | Description |
| --- | --- | --- |
| In | Exec |  |
| Actor | Actor Reference | The actor to restart. Left unconnected the pin shows **Self** and restarts the actor running the graph. |

## Outputs

| Pin | Type |
| --- | --- |
| Out | Exec |

## Notes

- Restarts every particle component on the actor, whatever its **Retrigger** setting, and also restarts systems that loop and are already playing.
- Particles still on screen, including earlier overlapped runs, disappear at once.
- The Particle component also has a **Restart** function that restarts only that component.
