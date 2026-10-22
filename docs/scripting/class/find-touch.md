---
node: input.findTouch
---

# Find Touch

Returns the touch with a given finger number this tick.

## Inputs

| Pin | Type | Description |
| --- | --- | --- |
| Finger | Integer | The finger number from a touch event, such as [On Touch Began](on-touch-began.md). |

## Outputs

| Pin | Type | Description |
| --- | --- | --- |
| Found | Boolean | False when no touch has this finger number this tick. |
| Touch | Touch | The whole touch as a single structure. |
| Position | Vector 2 | Where the touch is now, in pixels from the top-left corner of the game view. |
| Delta | Vector 2 | How far the touch moved this tick, in pixels. |
| Pressure | Float | From 0 to 1. Fingers and mice without pressure report 0.5. |
| Phase | TouchPhase | **Began**, **Moved**, **Stationary**, **Ended** or **Cancelled** this tick. |

## Notes

- A touch keeps its finger number until it ends, so storing the number from **On Touch Began** lets you follow one finger, for example a virtual stick on one side of the screen.
- When **Found** is false, the other outputs are zero.
