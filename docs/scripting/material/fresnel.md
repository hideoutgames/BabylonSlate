# Fresnel

Returns a value that is 1 where the surface faces the camera and falls toward its edges.

## Inputs

| Pin | Type | Default | Description |
| --- | --- | --- | --- |
| Bias | Float | 0 | Added to the facing amount before Power is applied; 0 adds nothing. |
| Power | Float | 1 | Exponent that shapes the falloff. Higher values narrow the area that reads as facing the camera. |

## Outputs

| Pin | Type |
| --- | --- |
| Out | Float |

## Notes

- Subtract the result from 1 with [**Subtract**](subtract.md) for a rim glow around the silhouette.
- Only in Surface and Landscape materials.
