# Create Particle

Starts the Particle chain and sets each new particle's speed, lifetime, colour, size and angle.

## Inputs

| Pin | Type | Default | Description |
| --- | --- | --- | --- |
| Emit Power | Float (m/s) | 1 | Launch speed in metres per second. It scales the direction the Shape picks. |
| Lifetime | Float (s) | 1 | How long each particle lives, in seconds. Values below 0.01 are raised to 0.01. |
| Color | Color | (1, 1, 1, 1) | Starting colour. A later [**Update Color**](update-color.md) replaces it unless its input reads [**Initial Color**](initial-color.md) or [**Particle Color**](particle-color.md). |
| Dead Color | Color | (0, 0, 0, 0) | The colour that [**Fade To Dead Color**](fade-to-dead-color.md) blends each particle towards over its life. |
| Size | Float | 1 | Starting size. A particle is drawn at **Size** multiplied by **Scale**. |
| Scale | Vector 2 | (1, 1) | Width and height multipliers applied to **Size**. |
| Angle | Float (rad) | 0 | Starting rotation in radians. |

## Outputs

| Pin | Type |
| --- | --- |
| Particle | Particle |

## Notes

- Its inputs are read once for each new particle, before the Shape sets the particle's position and direction.
- Wire its **Particle** output into a Shape, then any Update nodes, then [**Emitter Output**](emitter-output.md).
