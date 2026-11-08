---
node: random.seededUnitVector
---

# Seeded Random Unit Vector

Returns a random direction of length 1.

## Inputs

| Pin | Type | Description |
| --- | --- | --- |
| Seed | Seed | A Seed variable. Its Step moves on by the values drawn. |

## Outputs

| Pin | Type |
| --- | --- |
| Out | Vector |

## Notes

- Draws from **Seed** instead of the global seed, so the same Seed and Step give the same result on every device. [Random Unit Vector](random-unit-vector.md) draws from the global seed.
- **Seed** is a [reference pin](../pin-types.md#reference-pins): connect a Seed variable, not a value.
- Takes two steps. Each step adds 1 to the Seed variable's **Step**.
- Every direction is equally likely.
