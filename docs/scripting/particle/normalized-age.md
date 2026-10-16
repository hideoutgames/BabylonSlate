# Normalized Age

Returns how far through its life the particle is, from 0 at birth to 1 at death.

## Outputs

| Pin | Type |
| --- | --- |
| Normalized Age | Float |

## Notes

- Wire it into the **Ratio** of a [**Gradient**](gradient.md) to change a value over a particle's life.
- Reads the particle being processed, so it gives no value in **Emit Rate**.
