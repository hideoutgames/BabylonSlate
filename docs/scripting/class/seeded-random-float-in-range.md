---
node: random.seededFloatInRange
---

# Seeded Random Float In Range

Returns a random number from **Min** up to, but not including, **Max**.

## Inputs

| Pin | Type | Description |
| --- | --- | --- |
| Seed | Seed | A Seed variable. Its Step moves on by the values drawn. |
| Range | Float Range | The range to draw from. |

## Outputs

| Pin | Type |
| --- | --- |
| Value | Float |

## Notes

- Draws from **Seed** instead of the global seed, so the same Seed and Step give the same result on every device. [Random Float In Range](random-float-in-range.md) draws from the global seed.
- **Seed** is a [reference pin](../pin-types.md#reference-pins): connect a Seed variable, not a value.
- Takes one step. Each step adds 1 to the Seed variable's **Step**.
- If **Min** is greater than **Max**, the two are swapped.
- See [Curves and ranges](../curves-and-ranges.md).
