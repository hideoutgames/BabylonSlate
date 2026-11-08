---
node: random.seededShuffleArray
---

# Seeded Shuffle Array

Returns the Array's items in a random order.

## Inputs

| Pin | Type | Description |
| --- | --- | --- |
| Seed | Seed | A Seed variable. Its Step moves on by the values drawn. |
| Array | Array of Wildcard |  |

## Outputs

| Pin | Type |
| --- | --- |
| Out | Array of Wildcard |

## Notes

- Draws from **Seed** instead of the global seed, so the same Seed and Step give the same result on every device. [Shuffle Array](shuffle-array.md) draws from the global seed.
- **Seed** is a [reference pin](../pin-types.md#reference-pins): connect a Seed variable, not a value.
- Takes one step for each item after the first. Each step adds 1 to the Seed variable's **Step**.
- The Array you connect is left unchanged; **Out** is a new Array.
