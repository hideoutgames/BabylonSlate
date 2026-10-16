# Refract

Bends the Incident direction as it passes through a surface with the given Normal and Eta.

## Inputs

| Pin | Type | Default | Description |
| --- | --- | --- | --- |
| Incident | Vector 3 | (0, 0, -1) |  |
| Normal | Vector 3 | (0, 0, 1) |  |
| Eta | Float | 1 | Ratio of refractive indices: the index of the material the ray leaves divided by the index of the one it enters. |

## Outputs

| Pin | Type |
| --- | --- |
| Out | Vector 3 |

## Notes

- Incident and Normal should have a length of 1.
- Returns a zero vector on total internal reflection.
