---
node: anim.control.lookAt
---

# Look At

Turns one bone so its Aim Axis points at Target, within an angle limit, optionally keeping its Up Axis up, blended in by Alpha.

## Inputs

| Pin | Type | Description |
| --- | --- | --- |
| Source Pose | Pose | The pose whose bone to turn. |
| Target | Vector3 | The point to aim at, in **Target Space**. |
| Alpha | Float | How much of the turn to apply, from 0 to 1. Defaults to 1. |

## Outputs

| Pin | Type |
| --- | --- |
| Pose | Pose |

## Notes

- Pick the **Bone** in the **Inspector** from the graph's **Skeleton**, such as the head or a turret.
- Settings:

  | Setting | Description |
  | --- | --- |
  | **Target Space** | **Actor Space** (relative to the actor, turning with it) or **World Space**. Defaults to Actor Space. |
  | **Aim Axis** | The bone's own axis that points at Target: X, Y or Z, or its negative. Defaults to Z. |
  | **Up Axis** | **None**, or the bone's axis to keep leaning toward the actor's up as it aims, so the head does not roll. |
  | **Angle Limit** | The furthest it turns from where the pose aims it, in degrees. 180 has no limit. |
  | **Interpolation Time** | How long, in seconds, the bone takes to follow a target that jumps. 0 follows at once. |

- The turn applies after the pose's Animations blend, about the bone's own origin, so the bone keeps its place.
- A bone's axes depend on the rig. In the **Preview**, turn on **Bones** to see the target as an orange marker, and try each Aim Axis until the bone faces it.
- For a target an actor in the scene gives, set a Vector3 variable from the actor's [Get Actor Location](../class/get-actor-location.md) with [Set Anim Graph Variable](../class/set-anim-graph-variable.md), wire its Get Variable node to Target, and use World Space.
- Under a [Layered Blend Per Bone](layered-blend-per-bone.md) Blend Pose, the turn follows that input's weight on the bone.
