# Worley Noise

Returns 3D cell noise as distances to the nearest and second-nearest feature points.

## Inputs

| Pin | Type | Default | Description |
| --- | --- | --- | --- |
| Coordinates | Vector 3 | (0, 0, 0) | Position to sample. Multiply it to change the scale of the noise. |
| Jitter | Float | 1 | How far the points move from a regular grid: 0 is a regular grid and 1 is fully random. |

## Outputs

| Pin | Type | Description |
| --- | --- | --- |
| Distances | Vector 2 | F1 in X and F2 in Y. |
| F1 | Float | Distance to the nearest point. |
| F2 | Float | Distance to the second-nearest point. |

## Notes

- A constant position gives a constant value. Connect [**World Position**](world-position.md) or [**UV**](uv.md) for a pattern that varies across a surface.
