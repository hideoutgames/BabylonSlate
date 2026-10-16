# 2D Dropdown

A button that opens a list of options and shows the one the player picks.

## Add it

Select an actor in a Scene Layer, then choose **Add Component > Overlay > 2D Dropdown**. You can also place a ready-made actor from **Place Actors > Overlay > 2D Dropdown**.

Under the settings, the **Options** list holds the choices. Type a name and tap **Add Option**. Rows can be edited, reordered and removed.

## Settings

| Setting | Description |
| --- | --- |
| Enabled | Turns input on or off. Default on. |
| Width, Height | Size of the closed control, and of each row in the open list, in layer units. Default 4 by 0.6. |
| Placeholder | Shown while nothing is selected. |
| Selected Index | The chosen option, counting from 0. -1 selects nothing and shows the Placeholder. Default -1. |
| Font Size | Size of the text in layer units. Default 0.32. |
| Text Color | Colour of the text. Default white. |
| Opacity | Fades the whole control, from 0 to 1. Default 1. |
| Tint | Colour and alpha multiplied into every part. Default white. |
| Background Material, Background Texture | Replace the default look of the control and its rows. A Material or Material Instance, or a Texture. A Material wins when both are set. |
| Indicator Material, Indicator Texture | Replace the plus or minus sign at the right edge. |
| Focus Enabled, Initial Focus, Focus Up, Focus Down, Focus Left, Focus Right | Keyboard and gamepad focus. See [Scene Layers](../scenes/scene-layers.md). |

## Notes

- Scene Layers only.
- Tapping the control opens the list below it. Tapping a row selects it and closes the list.
- With focus, <kbd>Space</kbd> or <kbd>Enter</kbd> opens and closes the list. The up and down arrow keys change the selection, and <kbd>Home</kbd> and <kbd>End</kbd> pick the first and last option. <kbd>Escape</kbd> closes the list.
- Change the choice from a graph with **Set Selected Index**.
- [Event On Selection Changed](../scripting/class/event-on-selection-changed.md) gives you the index and the text of the chosen option.

## Related

- [Scene Layers](../scenes/scene-layers.md)
- [2D Radio Button](2d-radio-button.md)
