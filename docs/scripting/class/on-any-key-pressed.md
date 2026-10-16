---
node: input.onAnyKeyPressed
---

# On Any Key Pressed

Runs for each key, mouse button or gamepad control that is newly pressed.

## Outputs

| Pin | Type |
| --- | --- |
| Then | Exec |
| Key | Key |

## Notes

- Runs once for each key pressed in a frame, in press order, and not again for held keys or keyboard repeat.
- A primary touch counts as the left mouse button, and a gamepad stick counts when pushed past half way.
- Only in event graphs of classes that support [**Event Tick**](event-tick.md), not in functions or Animation Graphs.
