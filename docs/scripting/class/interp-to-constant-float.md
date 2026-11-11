---
node: math.floatInterpToConstant
---

# Interp To Constant Float

Moves a number toward a target at a steady speed.

## Inputs

| Pin | Type | Description |
| --- | --- | --- |
| Current | Float |  |
| Target | Float |  |
| Delta Time | Float |  |
| Interp Speed | Float | Defaults to 1. |

## Outputs

| Pin | Type |
| --- | --- |
| Out | Float |

## Notes

- Each call moves at most **Interp Speed** × **Delta Time**, and stops exactly at **Target**.
- **Interp Speed** 0 or below jumps straight to **Target**.
