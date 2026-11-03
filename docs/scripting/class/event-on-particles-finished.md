---
node: flow.event.particlesFinished
---

# Event On Particles Finished

Runs when a Particle component stops playing and its last particles are gone.

## Outputs

| Pin | Type | Description |
| --- | --- | --- |
| Out | Exec |  |
| Reason | Particles Finished Reason | **Finished** when a Particle System that does not loop ran out, **Stopped** when **Stop** was called. |

## Notes

- Belongs to a **Particle** component on an Actor.
- It runs after the drain: Stop halts emission at once, and the event waits until the particles already in flight have died.
- A looping Particle System only finishes when it is stopped.
- Playing again before the drain ends cancels the pending event; only the latest Play reports.
- The component's **Is Playing** already reads false when the event runs.
