---
node: update.basicColor
---

# Fade To Dead Color

Blends each particle from its colour to its dead colour over its lifetime.

## Inputs

| Pin | Type |
| --- | --- |
| Particle | Particle |

## Outputs

| Pin | Type |
| --- | --- |
| Particle | Particle |

## Notes

- Set the two colours with [**Color**](color.md) and [**Dead Color**](dead-color.md) on [**Create Particle**](create-particle.md).
- An [**Update Color**](update-color.md) placed after it replaces the faded colour.
