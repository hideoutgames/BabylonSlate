---
node: random.seededFloat
---

# Seeded Random Float

Returns a random number from 0 up to, but not including, 1.

## Inputs

| Pin | Type | Description |
| --- | --- | --- |
| Seed | Seed | A Seed variable. Its Step moves on by the values drawn. |

## Outputs

| Pin | Type |
| --- | --- |
| Out | Float |

## Notes

- Draws from **Seed** instead of the global seed, so the same Seed and Step give the same result on every device. [Random Float](random-float.md) draws from the global seed.
- **Seed** is a [reference pin](../pin-types.md#reference-pins): connect a Seed variable, not a value.
- Takes one step. Each step adds 1 to the Seed variable's **Step**.
