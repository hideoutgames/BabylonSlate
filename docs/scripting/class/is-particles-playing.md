---
node: particles.isPlaying
---

# Is Particles Playing

Returns whether any particle system on an actor is playing.

## Inputs

| Pin | Type | Description |
| --- | --- | --- |
| Actor | Actor Reference | The actor to check. Left unconnected the pin shows **Self** and checks the actor running the graph. |

## Outputs

| Pin | Type |
| --- | --- |
| Playing | Boolean |

## Notes

- True from **Play** until a Particle System that does not loop finishes, **Stop** is called, or the system cannot play (for example, a missing asset).
- It turns false as soon as **Stop** runs, while the particles in flight still finish their lifetime.
- The Particle component also has an **Is Playing** function that checks only that component.
