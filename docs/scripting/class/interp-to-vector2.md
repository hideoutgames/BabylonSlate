---
node: vector.interpTo2
---

# Interp To Vector2

Moves a vector smoothly toward a target, slowing as it arrives.

## Inputs

| Pin | Type | Description |
| --- | --- | --- |
| Current | Vector2 |  |
| Target | Vector2 |  |
| Delta Time | Float |  |
| Interp Speed | Float | Defaults to 1. |

## Outputs

| Pin | Type |
| --- | --- |
| Out | Vector2 |

## Notes

- Call it every frame with the frame's **Delta Time** and feed the result back in as **Current**.
- **Interp Speed** 0 or below jumps straight to **Target**.
