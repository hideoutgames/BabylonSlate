---
node: anim.control.footPlacement
---

# Foot Placement

Plants each foot on the ground beneath it with Two Bone IK, lowering the pelvis so the lower foot reaches, blended in by Alpha.

## Inputs

| Pin | Type | Description |
| --- | --- | --- |
| Source Pose | Pose | The pose whose feet to place. |
| Alpha | Float | How much of the placement to apply, from 0 to 1. Defaults to 1. |

## Outputs

| Pin | Type |
| --- | --- |
| Pose | Pose |

## Notes

- Under **Feet** in the **Inspector**, tap **Add Foot** and pick each foot (or ankle) bone. Its parent (the knee) and grandparent (the hip) bend to place it, as in [Two Bone IK](two-bone-ik.md).
- Each foot looks for ground straight below it, from **Trace Up** above to **Trace Down** below, in meters. It finds the meshes drawn in the scene, not the actor's own and not skinned characters.
- A foot moves up or down by the ground's height under it, measured from the actor's own ground level, so a foot the animation lifts in a step stays lifted by as much over a slope or a stair. A foot with no ground in reach stays as posed.
- With a **Pelvis Bone**, such as the hips, the pelvis drops by as much as the lowest foot goes down, so that leg can reach lower ground; feet over higher ground bend their knees.
- **Align To Ground** turns each foot to the slope of its ground. Off, feet keep their rotation from the pose.
- Placement follows what is drawn, so it is for looks: gameplay and physics never see it. Put the actor's own collision where the feet stand.
