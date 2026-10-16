# Desaturate

Blends a colour toward grey by the amount set in Level.

## Inputs

| Pin | Type | Default |
| --- | --- | --- |
| Color | Vector 3 |  |
| Level | Float | 1 |

## Outputs

| Pin | Type |
| --- | --- |
| Out | Vector 3 |

## Notes

- A Level of 0 keeps the colour and 1 gives grey.
- The grey is the midpoint of the brightest and darkest channels, not the perceived brightness.
