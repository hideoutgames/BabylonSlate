---
node: anim.pose.sequencePlayer
---

# Sequence Player

Plays an Animation.

## Inputs

| Pin | Type | Description |
| --- | --- | --- |
| Play Rate | Float | How fast the clip plays; 1 is normal speed, 0 holds the frame. Defaults to 1. |
| Start Position | Float | Where the clip starts when the state is entered, from 0 to 1. Defaults to 0. |

## Outputs

| Pin | Type |
| --- | --- |
| Pose | Pose |

## Notes

- Pick its **Animation** and **Loop** in the **Inspector**. A 3D Animation Graph offers only Animations on its Skeleton.
- Each Sequence Player keeps its own time, so a blend of two players plays both clips.
- In a state's graph, the player reached from **Output Pose** through each node's first pose input sets the state's time, length and looping, which transition rules read.
- Set its **Sync Group** in the **Inspector** to keep it in step with other looping players of the same name; see [Sync Groups](../../assets/animation-graph.md#sync-groups).
