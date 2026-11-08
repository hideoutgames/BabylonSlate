---
node: range.randomVector2
---

# Random Vector 2 In Range

Returns a random Vector 2 inside the range, with each axis drawn on its own.

## Inputs

| Pin | Type | Description |
| --- | --- | --- |
| Range | Vector 2 Range | The range to draw from. |

## Outputs

| Pin | Type | Description |
| --- | --- | --- |
| Value | Vector 2 |  |

## Notes

- Each axis is drawn from its **Min** up to, but not including, its **Max**, X first.
- Draws from the global seed, which each Play session starts afresh; see [Random numbers](../random-numbers.md).
- [Seeded Random Vector 2 In Range](seeded-random-vector2-in-range.md) draws from a Seed variable instead.
- If **Min** is greater than **Max**, the two are swapped.
- See [Curves and ranges](../curves-and-ranges.md).
