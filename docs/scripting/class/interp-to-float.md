---
node: math.floatInterpTo
---

# Interp To Float

Moves a number smoothly toward a target, slowing as it arrives.

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

- Call it every frame with the frame's **Delta Time** and feed the result back in as **Current**.
- Each call covers **Delta Time** × **Interp Speed** of the remaining distance (all of it at 1 or more).
- **Interp Speed** 0 or below jumps straight to **Target**.
