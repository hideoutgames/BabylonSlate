---
node: vector.split
---

# Split

Splits a Vector2, Vector3 or Color into separate Float components.

## Inputs

| Pin | Type | Description |
| --- | --- | --- |
| Value | Any | A Vector2, Vector3 or Color. |

## Outputs

| Pin | Type |
| --- | --- |
| X | Float |
| Y | Float |
| Z | Float |
| W | Float |

## Notes

- Missing components read as 0, so Z and W are 0 for a Vector2, and W is 0 for a Vector3.
- For a Color, X, Y, Z and W are red, green, blue and alpha.
