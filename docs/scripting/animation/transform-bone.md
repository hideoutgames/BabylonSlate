---
node: anim.control.transformBone
---

# Transform Bone

Changes one bone's translation, rotation and scale: each replaced or added to, in actor, parent or bone space, blended in by Alpha.

## Inputs

| Pin | Type | Description |
| --- | --- | --- |
| Source Pose | Pose | The pose whose bone to change. |
| Translation | Vector3 | The translation to set or add. |
| Rotation | Rotator | The rotation to set or add. |
| Scale | Vector3 | The scale to set or multiply by. Defaults to 1, 1, 1. |
| Alpha | Float | How much of the change to apply, from 0 to 1. Defaults to 1. |

## Outputs

| Pin | Type |
| --- | --- |
| Pose | Pose |

## Notes

- Pick the **Bone** in the **Inspector** from the graph's **Skeleton**.
- Each of **Translation Mode**, **Rotation Mode** and **Scale Mode** is one of:

  | Mode | Effect |
  | --- | --- |
  | **Ignore** | Leaves that part of the bone as the pose has it. This is the default. |
  | **Replace Existing** | Sets it to the pin's value. |
  | **Add To Existing** | Adds the pin's value to the pose's: translation and rotation are added, scale multiplies. |

- Each changed part has a **Space**:

  | Space | Axes |
  | --- | --- |
  | **Actor Space** | The actor's, relative to its origin. This is the default. |
  | **Parent Space** | The bone's parent's, as the bone's own values are stored. |
  | **Bone Space** | The bone's own. Translation moves along the bone's axes; Replace Existing works like Add To Existing. |

- The change applies after the pose's Animations blend: scale first, then rotation, then translation.
- Bone and Parent Space use the rig's own axes, which can differ from the actor's. Try a value in the **Preview**.
- Under a [Layered Blend Per Bone](layered-blend-per-bone.md) Blend Pose, the change follows that input's weight on the bone.
- When the change stops, the bone returns to its pose; a part no Animation keys returns to the Skeleton's rest pose.
