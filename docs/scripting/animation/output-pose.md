---
node: anim.pose.output
---

# Output Pose

The pose this graph produces. Every state graph ends in one.

## Inputs

| Pin | Type | Description |
| --- | --- | --- |
| Pose | Pose | The pose to play. |

## Notes

- Haptic adds it to every state graph, and you cannot delete it. It is drawn like a state card, with a person on its input.
- Its pose is the state's pose, which the State Machine blends through its transitions.
- Unconnected, the Skeleton keeps its rest pose.
