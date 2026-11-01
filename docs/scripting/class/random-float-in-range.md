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

- Draws from the session's seeded random generator, so Play repeats the same values for the same seed.
- If **Min** is greater than **Max**, the two are swapped.
- See [Curves and ranges](../curves-and-ranges.md).
