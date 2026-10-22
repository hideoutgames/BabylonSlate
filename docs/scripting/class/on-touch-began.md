---
node: input.onTouchBegan
---

# On Touch Began

Runs when a finger, a pen or the left mouse button touches the game view.

## Outputs

| Pin | Type | Description |
| --- | --- | --- |
| Then | Exec |  |
| Touch | Touch | The whole touch as a single structure. |
| Finger | Integer | The touch's finger number. It stays the same until the touch ends. |
| Position | Vector 2 | Where the touch began, in pixels from the top-left corner of the game view. |

## Notes

- Runs once for each new touch in a tick, in the order the touches began.
- A new touch takes the lowest finger number not in use, starting at 0. Use [Find Touch](find-touch.md) to follow it in later ticks.
- Touches that start on a [2D Joystick](../../components/2d-joystick.md) or another on-screen control in a Scene Layer are not reported.
- Only in event graphs of classes that support [**Event Tick**](event-tick.md), not in functions or Animation Graphs.
