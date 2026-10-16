---
node: shape.cylinder
---

# Cylinder Shape

Spawns particles inside a cylinder along the emitter's Y axis and launches them outwards.

## Inputs

| Pin | Type | Default | Description |
| --- | --- | --- | --- |
| Particle | Particle |  |  |
| Radius | Float | 1 |  |
| Height | Float | 1 | Height of the cylinder in metres, centred on the emitter. |
| Radius Range | Float | 1 | 0 spawns on the surface and 1 fills the volume. |
| Direction Randomizer | Float | 0 | Scatters the outward direction at random, from 0 (none) to 1 (most). Ignored when both directions are set. |
| Direction 1 | Vector 3 |  | Only used when **Direction 2** is also set. Then each particle launches in a random direction between the two. |
| Direction 2 | Vector 3 |  | Only used when **Direction 1** is also set. |

## Outputs

| Pin | Type |
| --- | --- |
| Particle | Particle |

## Notes

- The cylinder is centred on the emitter.
- Particles launch horizontally away from the axis unless both **Direction 1** and **Direction 2** are set.
