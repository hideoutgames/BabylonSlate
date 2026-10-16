# 2D Text Input

A single-line field the player types into.

## Add it

Select an actor in a Scene Layer, then choose **Add Component > Overlay > 2D Text Input**. You can also place a ready-made actor from **Place Actors > Overlay > 2D Text Input**.

## Settings

| Setting | Description |
| --- | --- |
| Enabled | Turns input on or off. Default on. |
| Width, Height | Size of the field in layer units. Default 4 by 0.6. |
| Text | The current text. Line breaks become spaces. |
| Placeholder | Shown while Text is empty. |
| Max Length | Most characters allowed. 0 means no limit. Default 0. |
| Read Only | The player can focus the field but not edit it. Default off. |
| Font Size | Size of the text in layer units. Default 0.32. |
| Text Color | Colour of the text. Default white. |
| Opacity | Fades the whole control, from 0 to 1. Default 1. |
| Tint | Colour and alpha multiplied into every part. Default white. |
| Background Material, Background Texture | Replace the default look of the field. A Material or Material Instance, or a Texture. A Material wins when both are set. |
| Indicator Material, Indicator Texture | Replace the caret and the selection highlight. |
| Focus Enabled, Initial Focus, Focus Up, Focus Down, Focus Left, Focus Right | Keyboard and gamepad focus. See [Scene Layers](../scenes/scene-layers.md). |

## Notes

- Scene Layers only.
- Tapping the field starts editing. On touch devices the on-screen keyboard opens, and input methods that compose text work as usual. Drag across the text to select it.
- <kbd>Enter</kbd> confirms. <kbd>Escape</kbd> puts back the text from before the edit.
- Text that is wider than the field shrinks to fit.
- Change the text from a graph with **Set Text**.
- [Event On Text Changed](../scripting/class/event-on-ui-text-changed.md) runs as the text changes. [Event On Text Submitted](../scripting/class/event-on-text-submitted.md) runs when the player confirms it.

## Related

- [Scene Layers](../scenes/scene-layers.md)
- [2D Numeric Input](2d-numeric-input.md)
- [2D Text](2d-text.md)
