---
node: anim.frame.spritePlayer
---

# Sprite Animation Player

Plays a Sprite Animation.

## Inputs

| Pin | Type | Description |
| --- | --- | --- |
| Play Rate | Float | How fast the frames play; 1 is normal speed, 0 holds the frame. Defaults to 1. |
| Start Frame | Integer | The frame the clip starts on when the state is entered, counted from 0. Defaults to 0. |

## Outputs

| Pin | Type |
| --- | --- |
| Frame | Frame |

## Notes

- Pick its **Sprite Animation** and **Loop** in the **Inspector**.
- Each player keeps its own time, even while a select node shows another input.
- Set its **Sync Group** in the **Inspector** to keep it in step with other looping players of the same name; see [Sync Groups](../../assets/animation-graph.md#sync-groups).
