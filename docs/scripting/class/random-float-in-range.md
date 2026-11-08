---
node: range.randomFloat
---

# Random Float In Range

Returns a random number from **Min** up to, but not including, **Max**.

## Inputs

| Pin | Type | Description |
| --- | --- | --- |
| Range | Float Range | The range to draw from. |

## Outputs

| Pin | Type | Description |
| --- | --- | --- |
| Value | Float |  |

## Notes

- Draws from the global seed, which each Play session starts afresh; see [Random numbers](../random-numbers.md).
- [Seeded Random Float In Range](seeded-random-float-in-range.md) draws from a Seed variable instead.
- If **Min** is greater than **Max**, the two are swapped.
- See [Curves and ranges](../curves-and-ranges.md).
