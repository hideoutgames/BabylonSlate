---
node: anim.pose.output
---

# Output Pose

The pose this graph produces. Every pose graph ends in one.

## Inputs

| Pin | Type | Description |
| --- | --- | --- |
| Pose | Pose | The pose to play. |

## Notes

- Haptic adds it to every pose graph, and you cannot delete it. It is drawn like a state card, with a person on its input.
- In the Anim Graph its pose is the one the Animation Graph component plays. In a state's graph it is that state's pose, which the State Machine blends through its transitions.
- Unconnected, the Skeleton keeps its rest pose.
