---
node: anim.pose.applyAdditive
---

# Apply Additive

Adds an additive Animation's change from its base pose, by Alpha, to the Base pose.

## Inputs

| Pin | Type | Description |
| --- | --- | --- |
| Base | Pose | The pose to add to. |
| Additive | Pose | The additive pose: players of [additive Animations](../../assets/animation.md#additive-animations), or blends of them. |
| Alpha | Float | How much of the change to add, from 0 to 1. Defaults to 1. |

## Outputs

| Pin | Type |
| --- | --- |
| Pose | Pose |

## Notes

- Use it for leans, breathing or flinches over any pose, and with a [Blend Space Player](blend-space-player.md) of additive Animations for aim poses.
- Positions and rotations add the change; scales multiply by it. A rotation turns the bone by the change before its own rotation.
- Players under **Additive** must play additive Animations, and additive Animations play only there; the graph reports either mistake.
- A Use Cached Pose under **Additive** adds that cached pose's change. [Transform Bone](transform-bone.md) changes nothing under **Additive**.
- The state's time follows **Base**.
- **Additive** keeps playing whatever the Alpha, so its clip does not restart when the Alpha rises again.
