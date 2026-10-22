---
node: input.onTouchMoved
---

# On Touch Moved

Runs when a touch moves across the game view.

## Outputs

| Pin | Type | Description |
| --- | --- | --- |
| Then | Exec |  |
| Touch | Touch | The whole touch as a single structure. |
| Finger | Integer | The touch's finger number. |
| Position | Vector 2 | Where the touch is now, in pixels from the top-left corner of the game view. |
| Delta | Vector 2 | How far the touch moved this tick, in pixels. |

## Notes

- Runs at most once for each touch in a tick, however many times it moved.
- For a touch that began this tick, **Delta** is the movement since it began.
- Only in event graphs of classes that support [**Event Tick**](event-tick.md), not in functions or Animation Graphs.
