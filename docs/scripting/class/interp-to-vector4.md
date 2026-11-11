---
node: vector.interpTo4
---

# Interp To Vector4

Moves a vector smoothly toward a target, slowing as it arrives.

## Inputs

| Pin | Type | Description |
| --- | --- | --- |
| Current | Vector4 |  |
| Target | Vector4 |  |
| Delta Time | Float |  |
| Interp Speed | Float | Defaults to 1. |

## Outputs

| Pin | Type |
| --- | --- |
| Out | Vector4 |

## Notes

- Call it every frame with the frame's **Delta Time** and feed the result back in as **Current**.
- **Interp Speed** 0 or below jumps straight to **Target**.
