---
node: texture.flipbook
---

# Flipbook

Returns the UV of one cell of a sprite sheet, for playing a sequence of frames from one texture.

## Inputs

| Pin | Type | Default | Description |
| --- | --- | --- | --- |
| UV | Vector2 |  | The UV to place inside the cell. When unconnected, uses the mesh UV or the particle UV. |
| Columns | Float | 4 | How many cells the sheet has across. |
| Rows | Float | 4 | How many cells the sheet has down. |
| Frame | Float | 0 | The cell to show. Its fractional part is dropped. |

## Outputs

| Pin | Type |
| --- | --- |
| Out | Vector2 |

## Notes

- Frame 0 is the top left cell. Frames run left to right, then down.
- A Frame past the last cell starts over from the first.
- Multiply [**Time**](time.md) by the frames per second and connect it to Frame to play the sheet.
- Connect Out to **UV** on [**Texture Sample**](texture-sample.md).
