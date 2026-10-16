# 2D Toggle

A switch with a sliding knob that turns a setting on or off.

## Add it

Select an actor in a Scene Layer, then choose **Add Component > Overlay > 2D Toggle**. You can also place a ready-made actor from **Place Actors > Overlay > 2D Toggle**.

## Settings

| Setting | Description |
| --- | --- |
| Enabled | Turns input on or off. Default on. |
| Width, Height | Size of the switch in layer units. Default 1.2 by 0.6. |
| Checked | Whether the switch is on. Default off. |
| Opacity | Fades the whole control, from 0 to 1. Default 1. |
| Tint | Colour and alpha multiplied into every part. Default white. |
| Background, Track, Fill and Thumb Material | Replace the default look of the body, the rail, the rail while on, and the knob. A Material or Material Instance. |
| Background, Track, Fill and Thumb Texture | The same, using a Texture. A Material wins when both are set. |
| Focus Enabled, Initial Focus, Focus Up, Focus Down, Focus Left, Focus Right | Keyboard and gamepad focus. See [Scene Layers](../scenes/scene-layers.md). |

## Notes

- Scene Layers only.
- The knob sits at the left when off and slides to the right when on. The Fill covers the Track while the switch is on.
- With focus, <kbd>Space</kbd> or <kbd>Enter</kbd> flips it.
- Read and write the state from a graph with the **Checked** variable and **Set Checked**.
- [Event On Checked Changed](../scripting/class/event-on-checked-changed.md) runs when the state changes.

## Related

- [Scene Layers](../scenes/scene-layers.md)
- [2D Checkbox](2d-checkbox.md)
- [2D Radio Button](2d-radio-button.md)
