---
node: input.particleColor
---

# Particle Color

Returns the colour and alpha the emitter gives to the particle being drawn.

## Outputs

| Pin | Type | Description |
| --- | --- | --- |
| RGBA | Vector4 | Red, green, blue and alpha. |
| RGB | Vector3 | Red, green and blue only. |
| A | Float | Alpha only. |

## Notes

- Only in Particle materials, in the fragment stage.
- Changing a material to the Particle domain connects it to [**Particle Output**](particle-output.md) for you.
- In the Material preview it is white.
