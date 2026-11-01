---
node: range.randomRotator
---

# Random Rotator In Range

Returns a random rotator inside the range, with each axis drawn on its own.

## Inputs

| Pin | Type | Description |
| --- | --- | --- |
| Range | Rotator Range | The range to draw from. |

## Outputs

| Pin | Type | Description |
| --- | --- | --- |
| Value | Rotator |  |

## Notes

- Each axis is drawn from its **Min** up to, but not including, its **Max**, in Pitch, Yaw, Roll order.
- Draws from the session's seeded random generator, so Play repeats the same values for the same seed.
- If **Min** is greater than **Max**, the two are swapped.
- See [Curves and ranges](../curves-and-ranges.md).
