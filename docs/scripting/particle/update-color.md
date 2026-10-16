---
node: update.color
---

# Update Color

Sets the colour of every particle each frame.

## Inputs

| Pin | Type |
| --- | --- |
| Particle | Particle |
| Color | Color |

## Outputs

| Pin | Type |
| --- | --- |
| Particle | Particle |

## Notes

- It replaces the particle's colour, so read [**Initial Color**](initial-color.md) or [**Particle Color**](particle-color.md) in its input to keep the colour from [**Create Particle**](create-particle.md).
- Multiply [**Initial Color**](initial-color.md) by a [**Gradient**](gradient.md) over [**Normalized Age**](normalized-age.md) to tint particles over their life.
