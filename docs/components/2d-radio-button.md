# 2D Radio Button

A round button that belongs to a group where only one button can be checked.

## Add it

Select an actor in a Scene Layer, then choose **Add Component > Overlay > 2D Radio Button**. You can also place a ready-made actor from **Place Actors > Overlay > 2D Radio Button**.

Add one radio button per choice and give them the same Group.

## Settings

| Setting | Description |
| --- | --- |
| Enabled | Turns input on or off. Default on. |
| Width, Height | Size of the button in layer units. Default 0.6 by 0.6. |
| Checked | Whether this button is the chosen one. Default off. |
| Group | The name of the group. Buttons with the same Group form one set. Default empty. |
| Opacity | Fades the whole control, from 0 to 1. Default 1. |
| Tint | Colour and alpha multiplied into every part. Default white. |
| Background Material, Background Texture | Replace the default look of the button, a round disc. A Material or Material Instance, or a Texture. A Material wins when both are set. |
| Indicator Material, Indicator Texture | Replace the dot shown while the button is checked. |
| Focus Enabled, Initial Focus, Focus Up, Focus Down, Focus Left, Focus Right | Keyboard and gamepad focus. See [Scene Layers](../scenes/scene-layers.md). |

## Notes

- Scene Layers only.
- Checking a button unchecks the others with the same Group in the same Scene Layer. Buttons in different layers never affect each other.
- The group updates before any [Event On Checked Changed](../scripting/class/event-on-checked-changed.md) runs, so a handler always sees a single choice.
- Tapping a checked button leaves it checked. To clear it, check another button, or call **Set Checked** with false.
- If several buttons in a group start checked, only the first stays checked.
- With focus, <kbd>Space</kbd> or <kbd>Enter</kbd> checks it.

## Related

- [Scene Layers](../scenes/scene-layers.md)
- [2D Checkbox](2d-checkbox.md)
- [2D Toggle](2d-toggle.md)
