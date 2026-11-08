---
node: random.getStepCount
---

# Get Step Count

Returns how many values have been drawn from **Seed**.

## Inputs

| Pin | Type |
| --- | --- |
| Seed | Seed |

## Outputs

| Pin | Type | Description |
| --- | --- | --- |
| Step Count | Integer | The Seed's **Step**. |

## Notes

- The same as reading **Step** with **Break Seed**.
- Each value a Seeded Random node draws adds one; see [Random numbers](../random-numbers.md#seeded-random-nodes).
