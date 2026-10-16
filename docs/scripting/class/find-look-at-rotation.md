# Find Look At Rotation

Returns the rotation that makes forward point from one location toward another.

## Inputs

| Pin | Type |
| --- | --- |
| From | Vector 3 |
| Target | Vector 3 |

## Outputs

| Pin | Type |
| --- | --- |
| Out | Rotator |

## Notes

- Only pitch and yaw are set; roll is 0.
- Returns no rotation when **From** and **Target** are the same point.
