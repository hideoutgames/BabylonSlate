---
node: shading.normalBlend
---

# Normal Blend

Combines two normal map colours into one, for adding a detail normal map to a base one.

## Inputs

| Pin | Type | Default |
| --- | --- | --- |
| A | Vector3 | (0.5, 0.5, 1) |
| B | Vector3 | (0.5, 0.5, 1) |

## Outputs

| Pin | Type |
| --- | --- |
| Packed | Vector3 |

## Notes

- Both inputs and the result are normal map colours, as a [**Texture Sample**](texture-sample.md) with Color Space set to Data (Linear) returns them.
- Connect Packed to **Packed** on [**Normal Map**](normal-map.md).
- The flat normal colour (0.5, 0.5, 1) leaves the other input unchanged.
