---
node: random.seededIntInRange
---

# Seeded Random Int In Range

Returns a random whole number from **Min** to **Max**.

## Inputs

| Pin | Type | Description |
| --- | --- | --- |
| Seed | Seed | A Seed variable. Its Step moves on by the values drawn. |
| Range | Int Range | The range to draw from. |

## Outputs

| Pin | Type |
| --- | --- |
| Value | Integer |

## Notes

- Draws from **Seed** instead of the global seed, so the same Seed and Step give the same result on every device. [Random Int In Range](random-int-in-range.md) draws from the global seed.
- **Seed** is a [reference pin](../pin-types.md#reference-pins): connect a Seed variable, not a value.
- Takes one step, or none when **Min** equals **Max**. Each step adds 1 to the Seed variable's **Step**.
- Both **Min** and **Max** can be returned.
- If **Min** is greater than **Max**, the two are swapped.
- See [Curves and ranges](../curves-and-ranges.md).
