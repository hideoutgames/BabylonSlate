---
node: anim.frame.spriteBlendSpacePlayer
---

# Sprite Blend Space Player

Plays the Sprite Animation of a [Sprite Blend Space](../../assets/sprite-blend-space.md) nearest X and Y.

## Inputs

| Pin | Type | Description |
| --- | --- | --- |
| X | Float | The position on the Sprite Blend Space's horizontal axis, such as Direction. Defaults to 0. |
| Y | Float | The position on its vertical axis. A one-axis Sprite Blend Space ignores it. Defaults to 0. |
| Play Rate | Float | How fast the frames play; 1 is normal speed, 0 holds the frame. Defaults to 1. |

## Outputs

| Pin | Type |
| --- | --- |
| Frame | Frame |

## Notes

- Pick its **Sprite Blend Space** in the **Inspector**.
- The sample nearest X and Y plays alone. Another takes over only once it is nearer by the Sprite Blend Space's **Hysteresis**; with **Keep Time** it goes on from the same point of its cycle.
- Inputs past an axis's range clamp to it, or wrap round on an axis with **Wrap**; an axis's **Smoothing Time** eases changes in the input.
- It always loops. As the first player reached from **Output Frame**, it sets the state's time and length, which transition rules read. A [Flip Frame](flip-frame.md) after it mirrors its frames.
- Set its **Sync Group** in the **Inspector** to keep it in step with other looping players of the same name; see [Sync Groups](../../assets/animation-graph.md#sync-groups).
