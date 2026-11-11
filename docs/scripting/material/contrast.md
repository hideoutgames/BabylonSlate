---
node: color.contrast
---

# Contrast

Pushes a colour away from or toward mid grey.

## Inputs

| Pin | Type | Default |
| --- | --- | --- |
| Color | Vector3 | (1, 1, 1) |
| Contrast | Float | 1 |

## Outputs

| Pin | Type |
| --- | --- |
| Out | Vector3 |

## Notes

- Returns (Color - 0.5) x Contrast + 0.5.
- A Contrast of 1 leaves the colour unchanged, above 1 adds contrast and below 1 flattens it.
- The result is not limited to 0 to 1. Use [**Saturate**](saturate.md) to clamp it.
