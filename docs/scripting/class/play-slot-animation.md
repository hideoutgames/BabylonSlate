---
node: anim.actor.playSlotAnimation
---

# Play Slot Animation

Plays an Animation (3D) or Sprite Animation (2D) once on a slot of the graph, over what the slot shows. On Blend Out runs as it starts blending out, On Completed once it has played through.

## Inputs

| Pin | Type | Description |
| --- | --- | --- |
| In | Exec |  |
| Target | AnimationGraphComponent Reference | The Animation Graph component to play on. |
| Animation | Animation Asset | The Animation to play: an Animation in a 3D graph, a Sprite Animation in a 2D graph. |
| Slot Name | String | The slot to play on. Defaults to DefaultSlot. |
| Blend In Time | Float | Seconds to blend in from what the slot shows. Defaults to 0.25. |
| Blend Out Time | Float | Seconds to blend back out before it ends. Defaults to 0.25. |
| Play Rate | Float | How fast it plays. Defaults to 1. |
| Loop Count | Integer | How many times it plays; 0 loops until stopped. Defaults to 1. |
| Start Time | Float | Seconds into the Animation to start at. Defaults to 0. |

## Outputs

| Pin | Type |
| --- | --- |
| On Blend Out | Exec |
| On Completed | Exec |

## Notes

- The Animation Graph shows it where a [Slot](../animation/slot.md) or [Frame Slot](../animation/frame-slot.md) node has the same **Slot Name**, in place of that node's Source.
- **On Blend Out** runs once it starts blending out: near its end, or when stopped or replaced. **On Completed** runs once it has played through and blended out. A play that is stopped, or replaced by another play on its slot, runs On Blend Out but not On Completed.
- A new play on a slot replaces the one playing there, which blends out under it.
- It starts on the next animation update. Nothing runs if the Animation is not one the graph can play.
- An **Animation** that has not loaded yet (a Soft reference, such as one picked on this pin that nothing else uses) loads first, and the play starts once it has; the slot keeps showing what it showed meanwhile. **On Blend Out** and **On Completed** follow that start. A warning names the Animation the first time. See [Soft and Hard assets](../variables.md#soft-and-hard-assets).
- While it loads, the latest request on the slot wins: another Play Slot Animation there, or [Stop Slot Animation](stop-slot-animation.md), cancels it, and so do destroying the actor or ending Play. A cancelled play never starts, so neither output runs. If the Animation fails to load or is not in the game, an error names it and nothing plays.
- Available in Actor class graphs and in Scene and Scene Layer scripts.
