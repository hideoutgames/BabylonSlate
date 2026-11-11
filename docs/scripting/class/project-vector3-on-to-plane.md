---
node: vector.projectOnToPlane
---

# Project Vector3 On To Plane

Flattens a vector onto a plane.

## Inputs

| Pin | Type | Description |
| --- | --- | --- |
| Vector | Vector3 |  |
| Plane Normal | Vector3 |  |

## Outputs

| Pin | Type |
| --- | --- |
| Out | Vector3 |

## Notes

- Removes the part of **Vector** along **Plane Normal**, which need not be one unit long.
