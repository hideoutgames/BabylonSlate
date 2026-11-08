---
node: random.shuffleArray
---

# Shuffle Array

Returns the Array's items in a random order.

## Inputs

| Pin | Type |
| --- | --- |
| Array | Array of Wildcard |

## Outputs

| Pin | Type |
| --- | --- |
| Out | Array of Wildcard |

## Notes

- The Array you connect is left unchanged; **Out** is a new Array.
- Every order is equally likely.
- Draws from the global seed, which each Play session starts afresh; see [Random numbers](../random-numbers.md).
- [Seeded Shuffle Array](seeded-shuffle-array.md) draws from a Seed variable instead.
