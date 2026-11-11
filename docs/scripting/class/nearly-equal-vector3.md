---
node: vector.nearlyEqual
---

# Nearly Equal Vector3

Returns true when two vectors are almost the same.

## Inputs

| Pin | Type | Description |
| --- | --- | --- |
| A | Vector3 |  |
| B | Vector3 |  |
| Tolerance | Float | Defaults to 0.0001. |

## Outputs

| Pin | Type |
| --- | --- |
| Out | Boolean |

## Notes

- Every axis must differ by no more than **Tolerance**.
