---
node: rotator.interpTo
---

# Rotator Interp To

Turns a rotator smoothly toward a target, slowing as it arrives.

## Inputs

| Pin | Type | Description |
| --- | --- | --- |
| Current | Rotator |  |
| Target | Rotator |  |
| Delta Time | Float |  |
| Interp Speed | Float | Defaults to 1. |

## Outputs

| Pin | Type |
| --- | --- |
| Return Value | Rotator |

## Notes

- Each axis turns the short way round, so yaw 170 to -170 passes 180.
- Call it every frame with the frame's **Delta Time** and feed the result back in as **Current**. **Interp Speed** 0 or below jumps straight to **Target**.
