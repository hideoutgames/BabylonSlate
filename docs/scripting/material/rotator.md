---
node: texture.rotator
---

# Rotator

Rotates UV coordinates around a centre point.

## Inputs

| Pin | Type | Default | Description |
| --- | --- | --- | --- |
| UV | Vector2 |  | Where to start from. When unconnected, uses the mesh UV, the particle UV or [**Screen UV**](screen-uv.md), depending on the material's domain. |
| Center | Vector2 | (0.5, 0.5) | The point the UV turns around. |
| Angle (Radians) | Float | 0 | How far to turn, in radians. |

## Outputs

| Pin | Type |
| --- | --- |
| Out | Vector2 |

## Notes

- A positive Angle turns the UV counter-clockwise, which turns the texture clockwise.
- Multiply [**Time**](time.md) into Angle to spin a texture.
- Use [**Degrees To Radians**](degrees-to-radians.md) to enter degrees.
- [**Transform UV**](transform-uv.md) rotates around UV (0, 0) instead.
