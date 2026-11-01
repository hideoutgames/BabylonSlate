---
node: range.randomInt
---

# Random Integer In Range

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
- Draws from the session's seeded random generator, so Play repeats the same values for the same seed.
- If **Min** is greater than **Max**, the two are swapped.
- See [Curves and ranges](../curves-and-ranges.md).
