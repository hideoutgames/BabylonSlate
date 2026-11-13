---
node: anim.pose.blendSpacePlayer
---

# Blend Space Player

Plays a [Blend Space](../../assets/blend-space.md): the Animations around X and Y, in step.

## Inputs

| Pin | Type | Description |
| --- | --- | --- |
| X | Float | The position on the Blend Space's horizontal axis, such as Speed. Defaults to 0. |
| Y | Float | The position on its vertical axis, such as Direction. A one-axis Blend Space ignores it. Defaults to 0. |
| Play Rate | Float | How fast the blend plays; 1 is normal speed, 0 holds the frame. Defaults to 1. |

## Outputs

| Pin | Type |
| --- | --- |
| Pose | Pose |

## Notes

- Pick its **Blend Space** in the **Inspector**. It must be on the graph's Skeleton.
- The samples nearest X and Y play together, weighted by how close each is. Inputs past an axis's range clamp to it, or wrap round on an axis with **Wrap**; an axis's **Smoothing Time** eases changes in the input.
- Every sample plays at the same point of its cycle, and one cycle lasts the samples' lengths averaged by their weights, so walking and running feet stay in step as the blend changes.
- It always loops. As the first player reached from **Output Pose**, it sets the state's time and length, which transition rules read.
