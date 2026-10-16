---
node: shape.cone
---

# Cone Shape

Spawns particles inside a cone that opens along the emitter's Y axis and launches them outwards.

## Inputs

| Pin | Type | Default | Description |
| --- | --- | --- | --- |
| Particle | Particle |  |  |
| Radius | Float | 1 | Radius of the wide end of the cone, in metres. |
| Angle | Float (rad) | 0.5235987755982988 | Full opening angle of the cone, in radians, from 0.01 to pi. |
| Radius Range | Float | 1 | 0 spawns on the surface and 1 fills the volume. |
| Height Range | Float | 1 | 0 spawns at the wide end only and 1 spawns anywhere from the tip to the wide end. |
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
| Emit From Spawn Point Only | Spawns every particle at the cone's tip instead of inside the cone. |

## Notes

- The cone narrows to a tip at the emitter and widens upwards.
- Particles launch away from the tip unless both **Direction 1** and **Direction 2** are set.
