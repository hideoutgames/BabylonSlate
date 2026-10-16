---
node: quat.normalize
---

# Normalize Quaternion

Scales a quaternion to a length of 1 so it is a valid rotation.

## Inputs

| Pin | Type |
| --- | --- |
| In | Quaternion |

## Outputs

| Pin | Type |
| --- | --- |
| Out | Quaternion |

## Notes

- A quaternion of length zero becomes no rotation, (0, 0, 0, 1).
