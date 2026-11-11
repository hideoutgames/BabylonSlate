---
node: range.randomInt
---

# Random Int In Range

Returns a random whole number from **Min** to **Max**.

## Inputs

| Pin | Type | Description |
| --- | --- | --- |
| Range | Int Range | The range to draw from. |

## Outputs

| Pin | Type | Description |
| --- | --- | --- |
| Value | Integer |  |

## Notes

- Both **Min** and **Max** can be returned.
- Draws from the global seed, which each Play session starts afresh; see [Random numbers](../random-numbers.md).
- [Seeded Random Int In Range](seeded-random-int-in-range.md) draws from a Seed variable instead.
- If **Min** is greater than **Max**, the two are swapped.
- See [Curves and ranges](../curves-and-ranges.md).
