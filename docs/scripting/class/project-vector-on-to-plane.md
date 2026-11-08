---
node: vector.projectOnToPlane
---

# Project Vector On To Plane

Flattens a vector onto a plane.

## Inputs

| Pin | Type | Description |
| --- | --- | --- |
| Vector | Vector 3 |  |
| Plane Normal | Vector 3 |  |

## Outputs

| Pin | Type |
| --- | --- |
| Return Value | Vector 3 |

## Notes

- Removes the part of **Vector** along **Plane Normal**, which need not be one unit long.
