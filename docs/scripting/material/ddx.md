# DDX

Returns how much Value changes between neighbouring pixels in the horizontal screen direction.

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
