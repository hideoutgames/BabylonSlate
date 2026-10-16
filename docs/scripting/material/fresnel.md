---
node: shading.fresnel
---

# Fresnel

Returns a value that is 0 where the surface faces the camera and rises to 1 at its edges, for rim lighting.

## Inputs

| Pin | Type | Default | Description |
| --- | --- | --- | --- |
| Bias | Float | 0 | Added to the edge amount before Power is applied; 0 adds nothing. Positive values brighten the whole surface, negative values pull the rim toward the edges. |
| Power | Float | 1 | Exponent that shapes the falloff. Higher values make a thinner rim. |

## Outputs

| Pin | Type |
| --- | --- |
| Out | Float |

## Notes

- For a rim glow, multiply the result by a color with [**Multiply**](multiply.md) and connect it to **Emissive** on the [**Material Output**](material-output.md).
- Subtract the result from 1 with [**Subtract**](subtract.md) for a value that is brightest where the surface faces the camera.
- Only in Surface and Landscape materials.
