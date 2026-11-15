---
node: anim.pose.useCachedPose
---

# Use Cached Pose

The pose a Save Cached Pose saved under this name.

## Outputs

| Pin | Type |
| --- | --- |
| Pose | Pose |

## Notes

- **Add Node** lists one **Use Cached Pose** row for each name a [Save Cached Pose](save-cached-pose.md) in the graph saves, such as **Use Cached Pose Locomotion**. Change the name with **Cached Pose** in the **Inspector**.
- It works in any state of the graph, not only the state holding the Save Cached Pose.
- A state whose output reaches a Use Cached Pose before any player keeps its own one-second clock for its time; the cached pose's players do not set it.
