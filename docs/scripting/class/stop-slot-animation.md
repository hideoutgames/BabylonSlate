---
node: anim.actor.stopSlotAnimation
---

# Stop Slot Animation

Blends a slot's Animation out over Blend Out Time; its Play Slot Animation runs On Blend Out but not On Completed.

## Inputs

| Pin | Type | Description |
| --- | --- | --- |
| In | Exec |  |
| Target | AnimationGraphComponent Reference | The Animation Graph component playing it. |
| Slot Name | String | The slot to stop. Defaults to DefaultSlot. |
| Blend Out Time | Float | Seconds to blend back to what the slot shows. Defaults to 0.25. |

## Outputs

| Pin | Type |
| --- | --- |
| Out | Exec |

## Notes

- Does nothing when nothing plays on the slot.
- A Play Slot Animation on the slot still waiting for its Animation to load is cancelled: it never starts, and neither of its outputs runs.
