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
- Draws from the global seed, which each Play session starts afresh; see [Random numbers](../random-numbers.md).
- [Seeded Random Rotator In Range](seeded-random-rotator-in-range.md) draws from a Seed variable instead.
- If **Min** is greater than **Max**, the two are swapped.
- See [Curves and ranges](../curves-and-ranges.md).
