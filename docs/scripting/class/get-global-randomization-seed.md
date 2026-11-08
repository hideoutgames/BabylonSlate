---
node: random.getGlobalSeed
---

# Get Global Randomization Seed

Returns the global seed.

## Outputs

| Pin | Type | Description |
| --- | --- | --- |
| Seed | Seed | The global seed, with the number of values drawn from it so far as its **Step**. |

## Notes

- Its **Step** counts every value the normal Random nodes have drawn since the session started or since the last [Set Global Randomization Seed](set-global-randomization-seed.md).
- Save it and pass it to **Set Global Randomization Seed** after loading to continue the same sequence.
