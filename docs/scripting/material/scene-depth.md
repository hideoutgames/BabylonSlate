# Scene Depth

Returns the linear depth of the rendered scene at a position on the screen.

## Inputs

| Pin | Type | Description |
| --- | --- | --- |
| UV | Vector 2 | Screen position to read; the current pixel when unconnected. |

## Outputs

| Pin | Type |
| --- | --- |
| Depth | Float |

## Notes

- Depth is linear, not the raw depth-buffer value.
- Needs the scene's depth buffer. If it is unavailable, the pass is skipped and an error appears on this node.
- Only in Post Process materials, in the fragment stage.
