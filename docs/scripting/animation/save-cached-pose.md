---
node: anim.pose.saveCachedPose
---

# Save Cached Pose

Saves a pose under a name, so Use Cached Pose nodes in any state reuse it, evaluated once a frame.

## Inputs

| Pin | Type | Description |
| --- | --- | --- |
| Pose | Pose | The pose to save. |

## Notes

- Set its **Name** in the **Inspector**. Each name can be saved once per Animation Graph.
- A pose output connects to one input only. To use a pose in more than one place, save it here and read it with [Use Cached Pose](use-cached-pose.md) nodes.
- The pose is worked out only while some state uses it, once a frame however many nodes use it, so its players keep their time as the State Machine moves between the states that use it.
- Its Animation Events fire once a frame, at the summed weight of its uses.
- A cached pose cannot use itself, directly or through another cached pose.
