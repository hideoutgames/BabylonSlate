---
node: color.blendScreen
---

# Blend Screen

Lightens Base by Blend, as the Screen blend mode of an image editor does.

## Inputs

| Pin | Type | Default |
| --- | --- | --- |
| Base | Any | 0 |
| Blend | Any | 0 |

## Outputs

| Pin | Type |
| --- | --- |
| Out | Any |

## Notes

- Returns 1 - (1 - Base) x (1 - Blend).
- Black in Blend leaves Base unchanged.
- For the other common blend modes use [**Multiply**](multiply.md), [**Add**](add.md), [**Minimum**](minimum.md) (Darken) and [**Maximum**](maximum.md) (Lighten).
