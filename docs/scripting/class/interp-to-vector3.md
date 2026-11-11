---
node: vector.interpTo
---

# Interp To Vector3

Moves a vector smoothly toward a target, slowing as it arrives.

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

- Call it every frame with the frame's **Delta Time** and feed the result back in as **Current**.
- **Interp Speed** 0 or below jumps straight to **Target**.
