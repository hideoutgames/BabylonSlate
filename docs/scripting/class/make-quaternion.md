---
node: quat.make
---

# Make Quaternion

Builds a quaternion from X, Y, Z and W components.

## Inputs

| Pin | Type |
| --- | --- |
| X | Float |
| Y | Float |
| Z | Float |
| W | Float |

## Outputs

| Pin | Type |
| --- | --- |
| Out | Quaternion |

## Notes

- The values are used as given and are not normalised. Use [**Normalize Quaternion**](normalize-quaternion.md) if you need a valid rotation.
- (0, 0, 0, 1) is no rotation.
