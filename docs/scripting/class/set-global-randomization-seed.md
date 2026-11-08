---
node: random.setGlobalSeed
---

# Set Global Randomization Seed

Makes the normal Random nodes continue from **Seed**.

## Inputs

| Pin | Type | Description |
| --- | --- | --- |
| In | Exec |  |
| Seed | Seed | The sequence to use and how far along it to start. |

## Outputs

| Pin | Type |
| --- | --- |
| Out | Exec |

## Notes

- Affects every node that draws from the global seed, such as [Random Float](random-float.md) and [Shuffle Array](shuffle-array.md), not the Seeded nodes.
- Each Play session starts the global seed afresh. Run this node to make the normal Random nodes return the same values every run.
- Pass the Seed from [Get Global Randomization Seed](get-global-randomization-seed.md) that you saved to continue a saved game's sequence. See [Random numbers](../random-numbers.md).
