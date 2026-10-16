# Get Cursor Position

Returns the pointer position over the game view.

## Outputs

| Pin | Type | Description |
| --- | --- | --- |
| Position | Vector 2 |  |
| Pressed | Boolean | True while the left mouse button is down or a finger touches the view. |

## Notes

- Position is in pixels from the top-left corner of the game view.
- Touch uses the first finger. The last position is kept after the pointer lifts.
