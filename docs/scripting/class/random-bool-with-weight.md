---
node: random.boolWithWeight
---

# Random Bool With Weight

Returns true with the chance **Weight**.

## Inputs

| Pin | Type | Description |
| --- | --- | --- |
| Weight | Float | The chance of true, from 0 (never) to 1 (always). Values outside are clamped. |

## Outputs

| Pin | Type |
| --- | --- |
| Out | Boolean |

## Notes

- A **Weight** of 0.25 returns true about one time in four.
- Draws from the global seed, which each Play session starts afresh; see [Random numbers](../random-numbers.md).
- [Seeded Random Bool With Weight](seeded-random-bool-with-weight.md) draws from a Seed variable instead.
