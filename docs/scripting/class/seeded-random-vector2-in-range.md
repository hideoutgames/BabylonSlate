---
node: random.seededVector2InRange
---

# Seeded Random Vector 2 In Range

Returns a random Vector 2 inside the range, with each axis drawn on its own.

## Inputs

| Pin | Type | Description |
| --- | --- | --- |
| Seed | Seed | A Seed variable. Its Step moves on by the values drawn. |
| Range | Vector 2 Range | The range to draw from. |

## Outputs

| Pin | Type |
| --- | --- |
| Value | Vector 2 |

## Notes

- Draws from **Seed** instead of the global seed, so the same Seed and Step give the same result on every device. [Random Vector 2 In Range](random-vector2-in-range.md) draws from the global seed.
- **Seed** is a [reference pin](../pin-types.md#reference-pins): connect a Seed variable, not a value.
- Takes two steps, X then Y. Each step adds 1 to the Seed variable's **Step**.
- See [Curves and ranges](../curves-and-ranges.md).
