---
node: particles.emitBurst
---

# Emit Particle Burst

Emits extra particles from the particle systems on an actor.

## Inputs

| Pin | Type | Description |
| --- | --- | --- |
| In | Exec |  |
| Actor | Actor Reference | The actor whose particles burst. Left unconnected the pin shows **Self** and uses the actor running the graph. |
| Count | Integer | How many particles each emitter adds. Default 10. |
| Slot | Integer | The emitter to burst, counted from 0 in the Particle System's emitter list. -1 (default) bursts every emitter. |

## Outputs

| Pin | Type |
| --- | --- |
| Out | Exec |

## Notes

- Works only while the particle component is playing. A burst never starts a system; on one that is stopped or finished it does nothing.
- The burst appears one frame later, like a burst in the emitter's **Spawn** module, and never during Pre Warm.
- **Count** is capped at the emitter's capacity.
- The Particle component also has an **Emit Burst** function that bursts only that component.
