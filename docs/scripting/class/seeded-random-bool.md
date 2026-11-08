---
node: random.seededBool
---

# Seeded Random Bool

Returns true or false with equal chance.

## Inputs

| Pin | Type | Description |
| --- | --- | --- |
| Seed | Seed | A Seed variable. Its Step moves on by the values drawn. |

## Outputs

| Pin | Type |
| --- | --- |
| Out | Boolean |

## Notes

- Draws from **Seed** instead of the global seed, so the same Seed and Step give the same result on every device. [Random Bool](random-bool.md) draws from the global seed.
- **Seed** is a [reference pin](../pin-types.md#reference-pins): connect a Seed variable, not a value.
- Takes one step. Each step adds 1 to the Seed variable's **Step**.
