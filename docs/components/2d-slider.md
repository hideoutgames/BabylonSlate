# 2D Slider

A draggable handle that picks a number between Min and Max.

## Add it

Select an actor in a Scene Layer, then choose **Add Component > Overlay > 2D Slider**. You can also place a ready-made actor from **Place Actors > Overlay > 2D Slider**.

## Settings

| Setting | Description |
| --- | --- |
| Enabled | Turns input on or off. Default on. |
| Width, Height | Size of the control in layer units. Default 4 by 0.6. |
| Min, Max | The range. Default 0 to 1. If Min is above Max, the two swap. |
| Step | Snaps the value to multiples of this amount from Min. 0 allows any value. Default 0.01. |
| Value | The current value, kept inside the range. Default is Min. |
| Orientation | Horizontal or Vertical. A vertical slider rises upward. Default Horizontal. |
| Opacity | Fades the whole control, from 0 to 1. Default 1. |
| Tint | Colour and alpha multiplied into every part. Default white. |
| Background, Track, Fill and Thumb Material | Replace the default look of the body, the rail, the filled part and the handle. A Material or Material Instance. |
| Background, Track, Fill and Thumb Texture | The same, using a Texture. A Material wins when both are set. |
| Focus Enabled, Initial Focus, Focus Up, Focus Down, Focus Left, Focus Right | Keyboard and gamepad focus. See [Scene Layers](../scenes/scene-layers.md). |

## Notes

- Scene Layers only.
- Players drag anywhere on the control. The drag continues when the pointer leaves it.
- With focus, the arrow keys move the value by one Step (or 1/100 of the range when Step is 0). <kbd>Home</kbd> and <kbd>End</kbd> jump to Min and Max.
- Read and write the value from a graph with the **Value** variable, **Set Value** and **Increment**. **Increment** adds a number of Steps.
- [Event On Value Changed](../scripting/class/event-on-value-changed.md) runs each time the value changes, including while dragging.
- Fade or tint it with [Tween 2D Opacity](../scripting/class/tween-2d-opacity.md) and [Tween 2D Tint](../scripting/class/tween-2d-tint.md).

## Related

- [Scene Layers](../scenes/scene-layers.md)
- [2D Range Slider](2d-range-slider.md)
- [2D Progress Bar](2d-progress-bar.md)
