---
node: input.getDeviceMotion
---

# Get Device Motion

Returns how the phone or tablet is tilted, moving and turning.

## Outputs

| Pin | Type | Description |
| --- | --- | --- |
| Available | Boolean | False until the device sends its first reading, and on devices without motion sensors. |
| Tilt | Vector 2 | From -1 to 1. X is positive when the right side tips down, Y when the top edge tips away. 30° from the calibrated pose is a full 1. |
| Acceleration | Vector 3 | How the device speeds up, in metres per second squared, without gravity. |
| Rotation Rate | Vector 3 | How fast the device turns around each axis, in degrees per second. |

## Notes

- All values follow the screen: X points right, Y up and Z out of the screen, even when the game turns to landscape.
- Tilt starts from the device lying flat. Use [Calibrate Tilt](calibrate-tilt.md) to start from how the player holds it.
- Reading this node turns on the device's motion sensors. On iPhone and iPad the player is asked to allow motion on their next tap.
- Only in event graphs of classes that support [**Event Tick**](event-tick.md), not in functions or Animation Graphs.
