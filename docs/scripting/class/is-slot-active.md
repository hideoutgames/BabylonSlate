---
node: anim.actor.isSlotActive
---

# Is Slot Active

Whether a slot is playing an Animation, blending out included.

## Inputs

| Pin | Type | Description |
| --- | --- | --- |
| Target | AnimationGraphComponent Reference | The Animation Graph component to ask. |
| Slot Name | String | The slot to check. Defaults to DefaultSlot. |

## Outputs

| Pin | Type |
| --- | --- |
| Value | Boolean |

## Notes

- True from the moment [Play Slot Animation](play-slot-animation.md) runs, before the next animation update starts it.
