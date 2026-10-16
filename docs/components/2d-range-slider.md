# 2D Range Slider

A slider with two handles that picks a lower and an upper value.

## Add it

Select an actor in a Scene Layer, then choose **Add Component > Overlay > 2D Range Slider**. You can also place a ready-made actor from **Place Actors > Overlay > 2D Range Slider**.

## Settings

| Setting | Description |
| --- | --- |
| Enabled | Turns input on or off. Default on. |
| Width, Height | Size of the control in layer units. Default 4 by 0.6. |
| Min, Max | The range. Default 0 to 1. If Min is above Max, the two swap. |
| Step | Snaps both values to multiples of this amount from Min. 0 allows any value. Default 0.01. |
| Lower Value, Upper Value | The two handle positions. Lower Value cannot pass Upper Value. They default to Min and Max. |
| Orientation | Horizontal or Vertical. A vertical slider rises upward. Default Horizontal. |
| Opacity | Fades the whole control, from 0 to 1. Default 1. |
| Tint | Colour and alpha multiplied into every part. Default white. |
| Background, Track, Fill and Thumb Material | Replace the default look of the body, the rail, the part between the handles and the handles. A Material or Material Instance. |
| Background, Track, Fill and Thumb Texture | The same, using a Texture. A Material wins when both are set. |
| Focus Enabled, Initial Focus, Focus Up, Focus Down, Focus Left, Focus Right | Keyboard and gamepad focus. See [Scene Layers](../scenes/scene-layers.md). |

## Notes

- Scene Layers only.
- A press moves the handle nearest to it. The handles cannot cross, and both use the Thumb Material or Texture.
- With focus, the arrow keys move the lower handle. Hold <kbd>Shift</kbd> to move the upper handle. <kbd>Home</kbd> and <kbd>End</kbd> jump the chosen handle to Min and Max.
- Set both handles from a graph with **Set Range**. The two values are sorted and clamped.
- [Event On Range Changed](../scripting/class/event-on-range-changed.md) runs when either value changes and gives you both.

## Related

- [Scene Layers](../scenes/scene-layers.md)
- [2D Slider](2d-slider.md)
