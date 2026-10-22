---
node: input.getTouch
---

# Get Touch

Returns one of this tick's touches by its place in the list.

## Inputs

| Pin | Type | Description |
| --- | --- | --- |
| Index | Integer | From 0 to [Get Touch Count](get-touch-count.md) minus 1. |

## Outputs

| Pin | Type | Description |
| --- | --- | --- |
| Valid | Boolean | False when there is no touch at **Index**. |
| Touch | Touch | The whole touch as a single structure. |
| Finger | Integer | The touch's finger number. |
| Position | Vector 2 | Where the touch is now, in pixels from the top-left corner of the game view. |
| Delta | Vector 2 | How far the touch moved this tick, in pixels. |
| Pressure | Float | From 0 to 1. Fingers and mice without pressure report 0.5. |
| Phase | TouchPhase | **Began**, **Moved**, **Stationary**, **Ended** or **Cancelled** this tick. |

## Notes

- Touches are listed by finger number, lowest first, so an index is not the same as a finger. Use [Find Touch](find-touch.md) to look up a finger.
- When **Valid** is false, **Finger** is -1 and the other outputs are zero.
