---
node: input.onTouchEnded
---

# On Touch Ended

Runs when a touch lifts from the game view or is cancelled.

## Outputs

| Pin | Type | Description |
| --- | --- | --- |
| Then | Exec |  |
| Touch | Touch | The whole touch as a single structure. |
| Finger | Integer | The touch's finger number. It is free again from the next tick. |
| Position | Vector 2 | Where the touch ended, in pixels from the top-left corner of the game view. |
| Cancelled | Boolean | True when the touch was interrupted instead of lifted. |

## Notes

- A touch is cancelled when the device interrupts it, for example for a system gesture, or when a [2D Scroll Box](../../components/2d-scroll-box.md) starts scrolling with it. A cancelled touch ends where it last moved.
- A tap that begins and ends within one tick runs [On Touch Began](on-touch-began.md) and then this node.
- Only in event graphs of classes that support [**Event Tick**](event-tick.md), not in functions or Animation Graphs.
