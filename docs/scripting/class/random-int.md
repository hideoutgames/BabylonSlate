---
node: math.randomInt
---

# Random Int

Returns a random whole number between **Min** and **Max**.

## Inputs

| Pin | Type |
| --- | --- |
| Min | Integer |
| Max | Integer |

## Outputs

| Pin | Type |
| --- | --- |
| Out | Integer |

## Notes

- Both **Min** and **Max** can be returned. If **Min** is greater than **Max**, the two are swapped.
- Draws from the global seed, which each Play session starts afresh; see [Random numbers](../random-numbers.md).
- [Seeded Random Int](seeded-random-int.md) draws from a Seed variable instead.
