---
node: shape.sphere
---

# Sphere Shape

Spawns particles inside a sphere around the emitter and launches them outwards.

## Inputs

| Pin | Type | Default | Description |
| --- | --- | --- | --- |
| Particle | Particle |  |  |
| Radius | Float | 1 |  |
| Radius Range | Float | 1 | 0 spawns on the surface and 1 fills the volume. |
| Direction Randomizer | Float | 0 | Scatters the outward direction at random, from 0 (none) to 1 (most). Ignored when both directions are set. |
| Direction 1 | Vector 3 |  | Only used when **Direction 2** is also set. Then each particle launches in a random direction between the two. |
| Direction 2 | Vector 3 |  | Only used when **Direction 1** is also set. |

## Outputs

| Pin | Type |
| --- | --- |
| Particle | Particle |

## Settings

| Setting | Description |
| --- | --- |
| Hemispheric | Spawns particles only in the upper half of the sphere, where Y is positive. |

## Notes

- Particles launch away from the sphere's centre unless both **Direction 1** and **Direction 2** are set.
