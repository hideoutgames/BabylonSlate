---
node: input.contextual.color
---

# Particle Color

Returns the current colour of the particle.

## Outputs

| Pin | Type |
| --- | --- |
| Particle Color | Color |

## Notes

- It starts as the [**Color**](color.md) from [**Create Particle**](create-particle.md) and changes as the particle is updated.
- Reads the particle being processed, so it gives no value in **Emit Rate**.
