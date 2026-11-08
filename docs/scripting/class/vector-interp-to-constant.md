---
node: vector.interpToConstant
---

# Vector Interp To Constant

Moves a vector straight toward a target at a steady speed.

## Inputs

| Pin | Type | Description |
| --- | --- | --- |
| Current | Vector 3 |  |
| Target | Vector 3 |  |
| Delta Time | Float |  |
| Interp Speed | Float | Defaults to 1. |

## Outputs

| Pin | Type |
| --- | --- |
| Return Value | Vector 3 |

## Notes

- Each call moves at most **Interp Speed** × **Delta Time** units, and stops exactly at **Target**.
- **Interp Speed** 0 or below jumps straight to **Target**.
