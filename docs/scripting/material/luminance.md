---
node: color.luminance
---

# Luminance

Returns how bright a colour is, as one Float.

## Inputs

| Pin | Type | Default |
| --- | --- | --- |
| Color | Vector3 | (1, 1, 1) |

## Outputs

| Pin | Type |
| --- | --- |
| Out | Float |

## Notes

- Weighs red, green and blue as [**Desaturate**](desaturate.md) does, so Luminance is the grey that Desaturate reaches at Level 1.
