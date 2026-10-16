# Split

Splits a Vector 2, Vector 3 or Color into separate Float components.

## Inputs

| Pin | Type | Default | Description |
| --- | --- | --- | --- |
| Value | Vector 4 | (0, 0, 0, 0) | A Vector 2, Vector 3 or Color. |

## Outputs

| Pin | Type |
| --- | --- |
| X | Float |
| Y | Float |
| Z | Float |
| W | Float |

## Notes

- Missing components read as 0, so Z and W are 0 for a Vector 2, and W is 0 for a Vector 3.
- For a Color, X, Y, Z and W are red, green, blue and alpha.
