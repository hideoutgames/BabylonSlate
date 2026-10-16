# 2D Checkbox

A box the player taps to switch a checked state on or off.

## Add it

Select an actor in a Scene Layer, then choose **Add Component > Overlay > 2D Checkbox**. You can also place a ready-made actor from **Place Actors > Overlay > 2D Checkbox**.

## Settings

| Setting | Description |
| --- | --- |
| Enabled | Turns input on or off. Default on. |
| Width, Height | Size of the box in layer units. Default 0.6 by 0.6. |
| Checked | Whether the box is checked. Default off. |
| Opacity | Fades the whole control, from 0 to 1. Default 1. |
| Tint | Colour and alpha multiplied into every part. Default white. |
| Background Material, Background Texture | Replace the default look of the box. A Material or Material Instance, or a Texture. A Material wins when both are set. |
| Indicator Material, Indicator Texture | Replace the mark shown while the box is checked. |
| Focus Enabled, Initial Focus, Focus Up, Focus Down, Focus Left, Focus Right | Keyboard and gamepad focus. See [Scene Layers](../scenes/scene-layers.md). |

## Notes

- Scene Layers only.
- With focus, <kbd>Space</kbd> or <kbd>Enter</kbd> toggles it.
- Read and write the state from a graph with the **Checked** variable and **Set Checked**.
- [Event On Checked Changed](../scripting/class/event-on-checked-changed.md) runs when the state changes, whether the player or a script changed it.
- To pick one option from several, use a [2D Radio Button](2d-radio-button.md). For a switch, use a [2D Toggle](2d-toggle.md).

## Related

- [Scene Layers](../scenes/scene-layers.md)
- [2D Radio Button](2d-radio-button.md)
- [2D Toggle](2d-toggle.md)
