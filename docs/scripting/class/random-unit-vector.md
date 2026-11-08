---
node: random.unitVector
---

# Random Unit Vector

Returns a random direction of length 1.

## Outputs

| Pin | Type |
| --- | --- |
| Out | Vector |

## Notes

- Every direction is equally likely.
- Draws from the global seed, which each Play session starts afresh; see [Random numbers](../random-numbers.md).
- [Seeded Random Unit Vector](seeded-random-unit-vector.md) draws from a Seed variable instead.
