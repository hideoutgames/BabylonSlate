---
node: color.nearlyEqual
---

# Nearly Equal Color

Returns true when two colours are equal within a small tolerance.

## Inputs

| Pin | Type | Description |
| --- | --- | --- |
| A | Color |  |
| B | Color |  |
| Tolerance | Float | Defaults to 0.0001. |

## Outputs

| Pin | Type |
| --- | --- |
| Out | Boolean |

## Notes

- Each channel, including alpha, must differ by no more than **Tolerance**.
