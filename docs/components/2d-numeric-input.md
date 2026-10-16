# 2D Numeric Input

An editable number with plus and minus buttons.

## Add it

Select an actor in a Scene Layer, then choose **Add Component > Overlay > 2D Numeric Input**. You can also place a ready-made actor from **Place Actors > Overlay > 2D Numeric Input**.

## Settings

| Setting | Description |
| --- | --- |
| Enabled | Turns input on or off. Default on. |
| Width, Height | Size of the control in layer units. Default 4 by 0.6. |
| Min, Max | The range. Default 0 to 100. If Min is above Max, the two swap. |
| Step | Amount each plus or minus tap changes the value. Typed values snap to multiples of it from Min. 0 allows any typed value, and the buttons then change it by 1. Default 1. |
| Value | The current value, kept inside the range. Default is Min. |
| Read Only | The player can focus the control but not change the value. Default off. |
| Font Size | Size of the text in layer units. Default 0.32. |
| Text Color | Colour of the text. Default white. |
| Opacity | Fades the whole control, from 0 to 1. Default 1. |
| Tint | Colour and alpha multiplied into every part. Default white. |
| Background Material, Background Texture | Replace the default look of the control. A Material or Material Instance, or a Texture. A Material wins when both are set. |
| Indicator Material, Indicator Texture | Replace the caret and the selection highlight. |
| Focus Enabled, Initial Focus, Focus Up, Focus Down, Focus Left, Focus Right | Keyboard and gamepad focus. See [Scene Layers](../scenes/scene-layers.md). |

## Notes

- Scene Layers only.
- Tap the left side to type a number. <kbd>Enter</kbd> confirms and <kbd>Escape</kbd> puts back the previous value. Text that is not a number is ignored.
- Tap the upper right (+) to add one Step and the lower right (-) to subtract one.
- With focus, the arrow keys change the value by one Step. <kbd>Home</kbd> and <kbd>End</kbd> jump to Min and Max.
- Read and write the value from a graph with **Set Value** and **Increment**.
- [Event On Value Changed](../scripting/class/event-on-value-changed.md) runs each time the value changes.

## Related

- [Scene Layers](../scenes/scene-layers.md)
- [2D Slider](2d-slider.md)
- [2D Text Input](2d-text-input.md)
