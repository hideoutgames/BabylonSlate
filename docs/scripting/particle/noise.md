---
node: update.noise
---

# Noise

Pushes each particle with a random force read from a noise texture, so particles drift apart unevenly.

## Inputs

| Pin | Type | Default | Description |
| --- | --- | --- | --- |
| Particle | Particle |  |  |
| Strength | Vector3 (m/s²) | (2, 2, 2) | The largest push on each axis, in metres per second squared. |

## Outputs

| Pin | Type |
| --- | --- |
| Particle | Particle |

## Settings

| Setting | Description |
| --- | --- |
| Texture | A Texture whose red channel sets the push. With none, the built-in noise is used. |

## Notes

- Each particle reads the noise at its own random points, so its push stays the same for its whole life while particles differ from each other. A dark pixel pushes towards negative, a bright one towards positive, mid grey not at all.
- Like [Gravity](gravity.md), it changes velocity only, so the chain also needs [Apply Velocity](apply-velocity.md) to move particles.
- A Texture is read once when the effect starts; until then, Noise pushes nothing. If the Texture is missing, the built-in noise is used and the **Output Log** shows a warning.
- Noise follows pause and time dilation.
