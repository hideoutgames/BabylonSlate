---
node: anim.frame.slot
---

# Frame Slot

Shows the Sprite Animations scripts play on this slot with Play Slot Animation instead of the Source frame.

## Inputs

| Pin | Type | Description |
| --- | --- | --- |
| Source | Frame | The frame shown while nothing plays on the slot. |

## Outputs

| Pin | Type |
| --- | --- |
| Frame | Frame |

## Notes

- Set its **Slot Name** in the **Inspector**; it is **DefaultSlot** unless you change it.
- Scripts play one-shots such as an attack or a hurt flash on it with [Play Slot Animation](../class/play-slot-animation.md), giving it a Sprite Animation.
- Frames cannot blend: the slot's Sprite Animation shows alone from the moment it plays until it has blended out.
- A slot's Sprite Animation plays for the whole graph, whichever state is active; a state with a Frame Slot of its name shows it.
