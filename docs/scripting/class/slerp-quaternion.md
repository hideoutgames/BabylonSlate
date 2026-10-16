---
node: quat.slerp
---

# Slerp Quaternion

Blends between two quaternions along the shortest path, using Alpha as the amount.

## Inputs

| Pin | Type |
| --- | --- |
| A | Quaternion |
| B | Quaternion |
| Alpha | Float |

## Outputs

| Pin | Type |
| --- | --- |
| Out | Quaternion |

## Notes

- **Alpha** of 0 returns **A** and 1 returns **B**. Values outside 0 to 1 are clamped.
