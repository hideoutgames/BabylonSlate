---
node: update.spriteCell
---

# Update Sprite Cell

Sets the [Sprite Sheet](sprite-sheet.md) cell of every particle each frame.

## Inputs

| Pin | Type | Default | Description |
| --- | --- | --- | --- |
| Particle | Particle |  |  |
| Cell | Float | 0 | Rounded down and kept within the sheet. |

## Outputs

| Pin | Type |
| --- | --- |
| Particle | Particle |

## Notes

- Cells are numbered from 0 at the top left, left to right, then row by row downwards.
- Wire a value to pick a frame per particle, for example [Random](random.md) for a random frame or [Normalized Age](normalized-age.md) times the cell count for one pass over its life.
- After [Animate Sprite Sheet](animate-sprite-sheet.md) on the chain, it replaces the animated cell.
- Without a Sprite Sheet on the chain it has no effect, and Compiler Results shows a warning.
