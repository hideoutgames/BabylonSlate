---
node: vector.nearlyEqual4
---

# Nearly Equal Vector4

Returns true when two vectors are almost the same.

## Inputs

| Pin | Type | Description |
| --- | --- | --- |
| A | Vector4 |  |
| B | Vector4 |  |
| Tolerance | Float | Defaults to 0.0001. |

## Outputs

| Pin | Type |
| --- | --- |
| Out | Boolean |

## Notes

- Every axis must differ by no more than **Tolerance**.
