# Fwidth

Returns the total change of Value across neighbouring pixels: the absolute DDX plus the absolute DDY.

## Inputs

| Pin | Type | Default |
| --- | --- | --- |
| Value | Any | 0 |

## Outputs

| Pin | Type |
| --- | --- |
| Out | Any |

## Notes

- Fragment stage only, so it cannot feed **World Position Offset**.
- Needs derivative support on the device.
