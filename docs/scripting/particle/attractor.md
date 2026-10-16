---
node: force.attractor
---

# Attractor

Pulls every particle towards a point, more strongly the closer it gets.

## Inputs

| Pin | Type | Default | Description |
| --- | --- | --- | --- |
| Particle | Particle |  |  |
| Position | Vector 3 | (0, 0, 0) | The world-space point that particles are pulled towards. |
| Strength | Float | 1 | How strongly particles are pulled. A negative value pushes them away. |

## Outputs

| Pin | Type |
| --- | --- |
| Particle | Particle |

## Notes

- Its inputs are read without a particle. If they read particle attributes, place the Attractor after another Update node.
