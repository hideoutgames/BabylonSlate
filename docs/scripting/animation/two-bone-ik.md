---
node: anim.control.twoBoneIk
---

# Two Bone IK

Moves a hand or foot to Effector by turning its parent and grandparent, bending toward Joint Target, blended in by Alpha.

## Inputs

| Pin | Type | Description |
| --- | --- | --- |
| Source Pose | Pose | The pose whose limb to move. |
| Effector | Vector3 | Where the end bone goes, in **Effector Space**. |
| Joint Target | Vector3 | A point the elbow or knee bends toward, in **Joint Target Space**. Used only with **Use Joint Target**. |
| Alpha | Float | How much of the change to apply, from 0 to 1. Defaults to 1. |

## Outputs

| Pin | Type |
| --- | --- |
| Pose | Pose |

## Notes

- Pick the **End Bone** in the **Inspector**: the hand (or wrist) of an arm, the foot (or ankle) of a leg. Its parent (the elbow or knee) and grandparent (the shoulder or hip) turn; bones above them do not.
- Settings:

  | Setting | Description |
  | --- | --- |
  | **Effector Space** | **Actor Space** (relative to the actor, moving with it) or **World Space**. Defaults to Actor Space. |
  | **Use Joint Target** | Bends the joint toward Joint Target. Off, it bends the way the pose already bends it. |
  | **Joint Target Space** | Actor Space or World Space, while Use Joint Target is on. |
  | **Max Stretch** | How far the limb may lengthen to reach an Effector out of its reach, as a multiple of its length. 1, the default, never stretches: the limb points at the Effector instead. |
  | **Keep Effector Rotation** | Keeps the end bone's rotation relative to the actor, so a foot stays level or a hand keeps its grip as the limb bends. Off, it turns with its parent. |

- The change applies after the pose's Animations blend, and Alpha blends each of the limb's bones from its pose.
- In the **Preview**, turn on **Bones** to see Effector as an orange marker and Joint Target as a violet one.
- For a target in the scene, set a Vector3 variable from that actor's [Get Actor Location](../class/get-actor-location.md) with [Set Anim Graph Variable](../class/set-anim-graph-variable.md), wire its Get Variable node to Effector, and use World Space.
- Under a [Layered Blend Per Bone](layered-blend-per-bone.md) Blend Pose, each bone's change follows that input's weight on it.
