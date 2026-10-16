---
node: gradient.sample
---

# Gradient

Returns a value sampled from a gradient of 2 to 8 stops at a position from 0 to 1.

## Inputs

| Pin | Type | Default | Description |
| --- | --- | --- | --- |
| Ratio | Float | 0 | Position along the gradient. Values outside 0 to 1 are limited to that range. |

## Outputs

| Pin | Type |
| --- | --- |
| Value | Color |

## Settings

| Setting | Description |
| --- | --- |
| Value Type | The type of the stops and of the output: Float, Vector 2, Vector 3 or Color. The default is Color. |
| Stops | The gradient stops, each with a position from 0 to 1 and a value. Colour stops use a gradient editor and Float stops use a curve editor. |

## Notes

- Wire [**Normalized Age**](normalized-age.md) into **Ratio** to change a value over a particle's life.
- Values between two stops are blended in a straight line.
