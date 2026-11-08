---
node: range.randomVector
---

# Random Vector In Range

Returns a random vector inside the range, with each axis drawn on its own.

## Inputs

| Pin | Type | Description |
| --- | --- | --- |
| Range | Vector Range | The range to draw from. |

## Outputs

| Pin | Type | Description |
| --- | --- | --- |
| Value | Vector 3 |  |

## Notes

- Each axis is drawn from its **Min** up to, but not including, its **Max**, in X, Y, Z order.
- Draws from the global seed, which each Play session starts afresh; see [Random numbers](../random-numbers.md).
- [Seeded Random Vector In Range](seeded-random-vector-in-range.md) draws from a Seed variable instead.
- If **Min** is greater than **Max**, the two are swapped.
- See [Curves and ranges](../curves-and-ranges.md).
