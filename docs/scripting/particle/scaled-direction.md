# Scaled Direction

Returns the particle's direction multiplied by the seconds simulated this frame.

## Outputs

| Pin | Type |
| --- | --- |
| Scaled Direction | Vector 3 |

## Notes

- Adding it to [**Position**](position.md) gives the particle's position after this frame's movement.
- Reads the particle being processed, so it gives no value in **Emit Rate**.
