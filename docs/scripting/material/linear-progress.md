---
node: ui.linearProgress
---

# Linear Progress

Returns a mask that fills the element in a straight line, for progress bars and health bars.

## Inputs

| Pin | Type | Default | Description |
| --- | --- | --- | --- |
| UV | Vector2 |  | Where the pixel sits, from 0 to 1 on each axis. When unconnected, uses the Element UV from [**User Interface Input**](user-interface-input.md). |
| Progress | Float | 0.5 | How much is filled, from 0 (empty) to 1 (full). |
| Direction | Vector2 | (1, 0) | The direction the fill grows in. (1, 0) fills from left to right and (0, 1) from the bottom up. Negative values reverse it: (-1, 0) fills from right to left. |

## Outputs

| Pin | Type | Description |
| --- | --- | --- |
| Mask | Float | 1 over the filled part and 0 over the rest. |

## Notes

- The edge of the fill is smoothed over one pixel. At Progress 0 or below the mask is 0 everywhere, and at 1 or above it is 1 everywhere.
- A diagonal Direction, such as (1, 1), fills from one corner to the opposite one.
- Multiply Mask into **Opacity** on [**User Interface Output**](user-interface-output.md), or use it as Alpha in a [**Mix**](mix.md) between an empty and a full colour.
- Wire a [**Float Parameter**](float-parameter.md) into Progress to give each [Material Instance](../../assets/material-instance.md) its own fill. To change it from a script, wire a [**Global Parameter**](global-parameter.md) into Progress and set it with [Set Global Float Parameter](../class/set-global-float-parameter.md).
- Only in User Interface materials, in the fragment stage.
