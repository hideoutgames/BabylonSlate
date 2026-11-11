---
node: color.rgbToHsl
---

# RGB To HSL

Converts a colour to hue, saturation and lightness.

## Inputs

| Pin | Type | Default |
| --- | --- | --- |
| RGB | Vector3 | (1, 1, 1) |

## Outputs

| Pin | Type |
| --- | --- |
| HSL | Vector3 |

## Notes

- Hue, saturation and lightness each run from 0 to 1. Hue 0 is red, 1/3 is green and 2/3 is blue.
- Change a channel and convert back with [**HSL To RGB**](hsl-to-rgb.md) to shift a colour's hue or saturation.
