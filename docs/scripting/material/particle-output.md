# Particle Output

Sets the colour and alpha of each particle drawn with the material.

## Inputs

| Pin | Type | Default |
| --- | --- | --- |
| Color | Vector 4 | (1, 1, 1, 1) |

## Notes

- Blending is controlled by the particle emitter, not by the material.
- Unconnected, particles draw white. Connect [**Particle Color**](particle-color.md) to keep the emitter's colour.
- Only in Particle materials.
