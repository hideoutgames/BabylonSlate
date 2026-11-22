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
| Input Type | What the field accepts: **Text** (the default), **Number**, **Integer**, **Email**, **Password**, **URL** or **Phone**. See [Input types](#input-types). |
| Max Length | Most characters allowed. 0 means no limit. Default 0. |
| Read Only | The player can focus the field but not edit it. Default off. |
| Font Size | Size of the text in layer units. Default 0.32. |
| Text Color | Colour of the text. Default white. |
| Opacity | Fades the whole control, from 0 to 1. Default 1. |
| Tint | Colour and alpha multiplied into every part. Default white. |
| Background Material, Background Texture | Replace the default look of the field. A Texture, or a [User Interface](../graphics/materials.md#user-interface-materials) Material or an Instance of one. Materials of other domains are not listed, and are not drawn if a script sets one. A Material wins when both are set. |
| Indicator Material, Indicator Texture | Replace the caret and the selection highlight. |
| Focus Enabled, Initial Focus, Focus Up, Focus Down, Focus Left, Focus Right | Keyboard and gamepad focus. See [Scene Layers](../scenes/scene-layers.md). |

## Input types

The Input Type picks the on-screen keyboard on touch devices and the characters the field keeps. Characters that do not fit are dropped as they are typed, pasted or set from a graph.

| Input Type | Keyboard | Keeps |
| --- | --- | --- |
| Text | Standard | Everything. |
| Number | Decimal | Digits, a minus sign in front and one decimal point. A comma counts as the point. |
| Integer | Number pad | Digits and a minus sign in front. |
| Email | Email | Everything except spaces. |
| Password | Standard | Everything. The field shows a dot for each character. |
| URL | Web address | Everything except spaces. |
| Phone | Phone pad | Digits, spaces and `+ - ( )`. |

- The type only filters characters. It does not check that an email or a web address is complete.
- **Text** in a graph is always the real text, for a Password too.
- A Number is still text. For a value with a range and steps, use [2D Numeric Input](2d-numeric-input.md).

## Notes

- Scene Layers only.
- Tapping the field starts editing. On touch devices the on-screen keyboard opens, and input methods that compose text work as usual. Drag across the text to select it.
- <kbd>Enter</kbd> confirms. <kbd>Escape</kbd> puts back the text from before the edit.
- Text that is wider than the field shrinks to fit.
- Change the text from a graph with **Set Text**.
- [Event On UI Text Changed](../scripting/class/event-on-ui-text-changed.md) runs as the text changes. [Event On Text Submitted](../scripting/class/event-on-text-submitted.md) runs when the player confirms it.

## Related

- [Scene Layers](../scenes/scene-layers.md)
- [2D Numeric Input](2d-numeric-input.md)
- [2D Text](2d-text.md)
