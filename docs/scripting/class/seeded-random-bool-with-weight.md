---
node: random.seededBoolWithWeight
---

# Seeded Random Bool With Weight

Returns true with the chance **Weight**.

## Inputs

| Pin | Type | Description |
| --- | --- | --- |
| Seed | Seed | A Seed variable. Its Step moves on by the values drawn. |
| Weight | Float | The chance of true, from 0 (never) to 1 (always). Values outside are clamped. |

## Outputs

| Pin | Type |
| --- | --- |
| Out | Boolean |

## Notes

- Draws from **Seed** instead of the global seed, so the same Seed and Step give the same result on every device. [Random Bool With Weight](random-bool-with-weight.md) draws from the global seed.
- **Seed** is a [reference pin](../pin-types.md#reference-pins): connect a Seed variable, not a value.
- Takes one step. Each step adds 1 to the Seed variable's **Step**.
- A **Weight** of 0.25 returns true about one time in four.
