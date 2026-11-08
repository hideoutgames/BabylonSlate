# Camera Shake

A reusable shake for the player's view, such as a hit, an explosion, an engine rumble or a slow sway. Scripts play it with [Play Camera Shake](../scripting/class/play-camera-shake.md).

## Create

In the **Content Browser**, choose **New Asset > Animation > Camera Shake**. A new shake is half a second of moderate Perlin Noise.

## Editor

Double-tap the asset to open it.

- **Preview** shows the shake on a small built-in set seen through a camera. Select **Play** to watch it, and **Stop** to blend it out; select **Stop** again to end it at once. Changes to the settings apply while it plays.
- **Inspector** holds the settings below.

## Settings

| Setting | Description |
| --- | --- |
| Pattern | **Perlin Noise** (default) moves the view in an organic, random way. **Sine Wave** sways it regularly. **Curves** follows curve assets you key by hand. |
| Duration | Seconds the shake lasts. 0 plays until a script stops it. Default 0.5. |
| Blend In Time, Blend Out Time | Seconds the shake takes to grow to full strength and to fade at its end. Blend Out Time is also how long **Stop Camera Shake** takes to fade it. Defaults 0.05 and 0.2. |
| Location Amplitude | How far the view moves along its own right (X), up (Y) and forward (Z) axes, in world units. Perlin Noise and Sine Wave. |
| Location Frequency | How many times a second the view moves along each axis. |
| Rotation Amplitude | How far the view turns in pitch, yaw and roll, in degrees. |
| Rotation Frequency | How many times a second it turns about each axis. |
| Field Of View Amplitude, Field Of View Frequency | How much the view widens and narrows, in degrees, and how often. An orthographic view zooms instead. |
| Location Curve, Rotation Curve, Field Of View Curve | Curves only. [Vector Curves](curve.md) for the offset and for pitch, yaw and roll (X, Y, Z), and a Float Curve for the Field Of View change, read at the shake's seconds. |
| Intensity Curve | Optional [Float Curve](curve.md) that multiplies the strength at each second of the shake, for example 1 falling to 0 for a hit that dies away. |

## Play a shake

| Node | Use |
| --- | --- |
| [Play Camera Shake](../scripting/class/play-camera-shake.md) | Shakes the view, whichever camera is in view. |
| [Play World Camera Shake](../scripting/class/play-world-camera-shake.md) | Shakes the view less the farther it is from a point, as an explosion would. |
| [Play Camera Shake On Scene Layer](../scripting/class/play-camera-shake-on-scene-layer.md) | Shakes a Scene Layer's own view. |

Each returns a **Handle** for [Stop Camera Shake](../scripting/class/stop-camera-shake.md), [Pause Camera Shake](../scripting/class/pause-camera-shake.md), [Resume Camera Shake](../scripting/class/resume-camera-shake.md), [Set Camera Shake Scale](../scripting/class/set-camera-shake-scale.md), [Is Camera Shake Playing](../scripting/class/is-camera-shake-playing.md) and [Is Camera Shake Paused](../scripting/class/is-camera-shake-paused.md). [Stop All Camera Shakes](../scripting/class/stop-all-camera-shakes.md) stops every shake.

## Notes

- Several shakes on one view add together.
- A shake moves only what the player sees. The camera actor stays where it is, so scripts, physics and audio keep the steady position.
- Shakes follow time dilation and hold while the game is paused. A Scene change ends them.
- The free camera never shakes.

## Related

- [Cameras](../graphics/cameras.md)
- [Float Curve, Vector Curve, Color Curve](curve.md)
