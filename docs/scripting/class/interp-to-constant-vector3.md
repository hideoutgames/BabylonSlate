---
node: vector.interpToConstant
---

# Interp To Constant Vector3

Moves a vector straight toward a target at a steady speed.

## Inputs

| Pin | Type | Description |
| --- | --- | --- |
| Current | Vector3 |  |
| Target | Vector3 |  |
| Delta Time | Float |  |
| Interp Speed | Float | Defaults to 1. |

## Outputs

| Pin | Type |
| --- | --- |
| Out | Vector3 |

## Notes

- Each call moves at most **Interp Speed** × **Delta Time** units, and stops exactly at **Target**.
- **Interp Speed** 0 or below jumps straight to **Target**.
