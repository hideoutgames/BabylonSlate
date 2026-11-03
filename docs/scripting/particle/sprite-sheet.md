---
node: sprite.setup
---

# Sprite Sheet

Draws each particle as one cell of a sprite sheet: a texture divided into a grid of equal frames.

## Inputs

| Pin | Type |
| --- | --- |
| Particle | Particle |

## Outputs

| Pin | Type |
| --- | --- |
| Particle | Particle |

## Settings

| Setting | Description |
| --- | --- |
| Columns | How many cells the sheet has across. |
| Rows | How many cells the sheet has down. |
| Start Cell | The cell particles are born on, and where [Animate Sprite Sheet](animate-sprite-sheet.md) starts. |
| End Cell | The last cell Animate Sprite Sheet shows. |
| Frames Per Second | How many cells Animate Sprite Sheet steps through each second of a particle's life. 0 holds the first cell. |
| Loop | After End Cell, Animate Sprite Sheet starts again at Start Cell. Off, it stays on End Cell. |
| Random Start Cell | Each particle is born on a random cell from Start Cell to End Cell. |

## Notes

- The sheet is the texture the Particle Graph's Material samples with its default particle UV. A Material that does not sample a texture looks the same on every cell.
- Cells are numbered from 0 at the top left, left to right, then row by row downwards. A 4 × 4 sheet has cells 0 to 15.
- On its own, Sprite Sheet keeps each particle on its first cell. Add [Animate Sprite Sheet](animate-sprite-sheet.md) to play the frames, or [Update Sprite Cell](update-sprite-cell.md) to pick a cell from a value.
- With two Sprite Sheets on the chain, the one nearer Emitter Output is used and Compiler Results shows a warning.
