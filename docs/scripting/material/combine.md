---
node: vector.combine
---

# Combine

Builds a Vector2, Vector3 or Color from separate Float values.

## Inputs

| Pin | Type | Default | Description |
| --- | --- | --- | --- |
| X | Float | 0 |  |
| Y | Float | 0 |  |
| Z | Float | 0 |  |
| W | Float | 1 | The alpha of the [**Color**](color.md) output. It is not used by **XY** or **XYZ**. |

## Outputs

| Pin | Type |
| --- | --- |
| XY | Vector2 |
| XYZ | Vector3 |
| XYZW | Vector4 |

## Notes

- Use the output that matches the type you need and leave the others unconnected.
