# 2D Progress Bar

A display-only bar that fills to show a value between Min and Max, such as health or loading progress.

## Add it

Select an actor in a Scene Layer, then choose **Add Component > Overlay > 2D Progress Bar**. You can also place a ready-made actor from **Place Actors > Overlay > 2D Progress Bar**.

## Settings

| Setting | Description |
| --- | --- |
| Enabled | Turns the control on or off. Default on. |
| Width, Height | Size of the bar in layer units. Default 4 by 0.6. |
| Min, Max | The range. Default 0 to 1. If Min is above Max, the two swap. |
| Value | The current value, kept inside the range. Default is Min. |
| Orientation | Horizontal or Vertical. A vertical bar fills upward. Default Horizontal. |
| Opacity | Fades the whole control, from 0 to 1. Default 1. |
| Tint | Colour and alpha multiplied into every part. Default white. |
| Background, Track and Fill Material | Replace the default look of the body, the rail and the filled part. A Material or Material Instance. |
| Background, Track and Fill Texture | The same, using a Texture. A Material wins when both are set. |

## Notes

- Scene Layers only.
- The bar does not react to taps or keys and cannot take focus.
- Drive it from a graph with the **Value** variable or **Set Value**. Use [Tween Float](../scripting/class/tween-float.md) for a smooth change.
- [Event On Value Changed](../scripting/class/event-on-value-changed.md) runs when the value changes.

## Related

- [Scene Layers](../scenes/scene-layers.md)
- [2D Slider](2d-slider.md)
