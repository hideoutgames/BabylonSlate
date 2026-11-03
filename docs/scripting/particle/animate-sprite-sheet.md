---
node: update.basicSprite
---

# Animate Sprite Sheet

Steps each particle through the cells of the [Sprite Sheet](sprite-sheet.md) as it ages.

## Inputs

| Pin | Type |
| --- | --- |
| Particle | Particle |

## Outputs

| Pin | Type |
| --- | --- |
| Particle | Particle |

## Notes

- Each particle shows its first cell, then moves on by the Sprite Sheet's **Frames Per Second** through **End Cell**. With **Loop** it starts again at **Start Cell**; without, it stays on End Cell.
- Particles of different ages show different frames. Frames follow the particle's age, so pause and time dilation slow them too.
- Without a Sprite Sheet on the chain it has no effect, and Compiler Results shows a warning.
