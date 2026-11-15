---
node: anim.control.springBones
---

# Spring Bones

Simulates the bones below a Root Bone as springs that trail the pose, such as a tail, hair or a cape, blended in by Alpha.

## Inputs

| Pin | Type | Description |
| --- | --- | --- |
| Source Pose | Pose | The pose the bones spring from. |
| Alpha | Float | How much of the simulation to show, from 0 to 1. Defaults to 1. |

## Outputs

| Pin | Type |
| --- | --- |
| Pose | Pose |

## Notes

- Pick the **Root Bone** in the **Inspector**, such as the first bone of a tail. Every bone below it simulates; the Root Bone stays where the pose puts it and turns to follow its children.
- Each bone follows where the pose puts it, relative to its parent, through a damped spring. The simulation steps 120 times a second, by the game's tick time, so a replay looks the same. It is only for looks: gameplay and physics never see it.
- Settings:

  | Setting | Description |
  | --- | --- |
  | **Stiffness** | How strongly each bone returns to its pose, from 0 to 1. |
  | **Damping** | How much speed each bone loses, from 0 to 1. |
  | **World Damping Location** | How much of the actor's movement the chain ignores. 0 lets it trail fully as the actor moves; 1 moves it with the actor. |
  | **World Damping Rotation** | The same for the actor's turning. |
  | **Gravity** | A pull in world space, in meters per second squared, such as 0, -9.8, 0. |
  | **Wind Direction**, **Wind Strength** | A world-space push that gusts. **Wind Seed** shapes the gusts, so chains with the same seed gust together. |
  | **Radius** | Each bone's size against the colliders, in meters. |
  | **Limit Angle** | The furthest a bone turns away from its pose, in degrees. 0 has no limit. |
  | **Stiffness Curve**, **Damping Curve**, **Radius Curve**, **Limit Angle Curve** | Multiply their setting along the chain, from the Root Bone (left) to the tip (right), such as a tail that softens toward its end. |
  | **Planar Constraint** | **Lock X**, **Lock Y** or **Lock Z** keeps the chain from moving along that axis of the actor. |
  | **Teleport Distance**, **Teleport Angle** | When the actor moves or turns further than this in one tick, the chain starts again from its pose instead of whipping. 0 never resets. |
  | **Tip Length** | Adds a tip past each last bone, in meters, so that bone swings too. |

- **Exclude Bones** keeps bones, and every bone below them, posed: tap **Add Bone** and pick one.
- **Colliders** keep the chain out of a **Sphere**, a **Capsule** or behind a **Plane**, each bound to a bone with an **Offset** in that bone's axes. Tap **Add Collider** and pick its bone.
- The chain keeps simulating across states whose graphs have a Spring Bones node on the same Root Bone.
- In the **Preview**, turn on **Bones** to see the colliders.
- Sizes and distances are in the actor's units, meters for an actor at scale 1.
