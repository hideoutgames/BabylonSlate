---
node: anim.pose.blendByInt
---

# Blend Poses By Int

Blends to the pose Active Index picks.

## Inputs

| Pin | Type | Description |
| --- | --- | --- |
| Pose0 | Pose | The pose at index 0. |
| Pose1 | Pose | The pose at index 1. |
| Active Index | Integer | The pose to blend to. Defaults to 0. |

## Outputs

| Pin | Type |
| --- | --- |
| Pose | Pose |

## Notes

- Set **Poses**, the number of pose inputs from 2 to 16, and **Blend Time** in the **Inspector**.
- An index outside the range picks the nearest pose.
