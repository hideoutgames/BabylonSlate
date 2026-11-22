---
node: ui.radialProgress
---

# Radial Progress

Returns a mask that fills the element like a clock hand sweeping around its centre, for cooldowns and round timers.

## Inputs

| Pin | Type | Default | Description |
| --- | --- | --- | --- |
| UV | Vector2 |  | Where the pixel sits, from 0 to 1 on each axis. When unconnected, uses the Element UV from [**User Interface Input**](user-interface-input.md). |
| Progress | Float | 0.5 | How much is filled, from 0 (empty) to 1 (a full turn). |
| Start Angle (Degrees) | Float | 0 | Where the fill starts. 0 is straight up, and positive angles turn clockwise: 90 starts at the right. |

## Outputs

| Pin | Type | Description |
| --- | --- | --- |
| Mask | Float | 1 over the swept part and 0 over the rest. |

## Notes

- The fill grows clockwise from Start Angle around the centre of the UV, (0.5, 0.5).
- The edges of the fill are smoothed. At Progress 0 or below the mask is 0 everywhere, and at 1 or above it is 1 everywhere.
- Multiply Mask by the Fill of an [**Ellipse**](ellipse.md) for a round cooldown, then into **Opacity** on [**User Interface Output**](user-interface-output.md).
- Wire a [**Float Parameter**](float-parameter.md) into Progress to give each [Material Instance](../../assets/material-instance.md) its own fill. To change it from a script, wire a [**Global Parameter**](global-parameter.md) into Progress and set it with [Set Global Float Parameter](../class/set-global-float-parameter.md).
- Only in User Interface materials, in the fragment stage.
