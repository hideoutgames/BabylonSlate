---
node: anim.pose.slot
---

# Slot

Shows the Animations scripts play on this slot with Play Slot Animation over the Source pose.

## Inputs

| Pin | Type | Description |
| --- | --- | --- |
| Source | Pose | The pose shown while nothing plays on the slot. |

## Outputs

| Pin | Type |
| --- | --- |
| Pose | Pose |

## Notes

- Set its **Slot Name** in the **Inspector**; it is **DefaultSlot** unless you change it. Several Slot nodes, in one state or in several, can show the same slot.
- Scripts play one-shots such as attacks on it with [Play Slot Animation](../class/play-slot-animation.md), which blends the Animation in over Source and out again.
- A slot's Animation plays for the whole graph, not for a state: it keeps playing, and ends, whichever state is active. A state with a Slot node of its name shows it; another state does not.
- Put a Slot under a [Layered Blend Per Bone](layered-blend-per-bone.md) Blend Pose to play an attack on the upper body only.
- **Source** keeps playing underneath, so it carries on where it is when the slot Animation ends. The state's time follows **Source**.
- The slot Animation's Animation Events fire at its weight.
