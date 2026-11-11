---
node: rotator.lerp
---

# Lerp Rotator

Blends between two rotators along the shortest turn, using Alpha as the amount.

## Inputs

| Pin | Type |
| --- | --- |
| A | Rotator |
| B | Rotator |
| Alpha | Float |

## Outputs

| Pin | Type |
| --- | --- |
| Out | Rotator |

## Notes

- **Alpha** of 0 returns **A** and 1 returns **B**. A value outside 0 to 1 carries the turn on past either end, as [**Lerp**](lerp.md) does.
- The blend is a smooth turn between the two rotations, not an average of each angle.
