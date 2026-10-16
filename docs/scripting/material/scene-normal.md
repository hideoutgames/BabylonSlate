# Scene Normal

Returns the world-space normal of the scene geometry at a position on the screen.

## Inputs

| Pin | Type | Description |
| --- | --- | --- |
| UV | Vector 2 | Screen position to read; the current pixel when unconnected. |

## Outputs

| Pin | Type |
| --- | --- |
| Normal | Vector 3 |

## Notes

- Needs the scene's normal buffer. If it is unavailable, the pass is skipped and an error appears on this node.
- Only in Post Process materials, in the fragment stage.
