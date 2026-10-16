# 2D Focus Target

Lets keyboard and gamepad navigation reach any overlay element.

## Add it

Select an actor in a Scene Layer, then choose **Add Component > Overlay > 2D Focus Target**. You can also place a ready-made actor from **Place Actors > Overlay > 2D Focus Target**.

The target draws nothing and has no tap area. It takes its position and size from the actor's visual, so add it to an actor that has one, or to a child of that actor.

## Settings

| Setting | Description |
| --- | --- |
| Focus Enabled | Lets keyboard and gamepad navigation reach this element. Default on. |
| Initial Focus | Gives this element focus when the layer becomes active. Default off. |
| Focus Up, Focus Down, Focus Left, Focus Right | Which element receives focus in that direction. Automatic picks the nearest one. Or pick another focus target in the layer. A chosen target that is hidden or disabled stops navigation. |

## Notes

- Scene Layers only.
- A [2D Button](2d-button.md) and the form controls already take focus. Use a Focus Target for anything else, such as a card or a list row.
- Hidden, disabled and destroyed owners are skipped. Navigation stays within one Scene Layer.
- Respond with [Event On Focus Enter](../scripting/class/event-on-focus-enter.md), [Event On Focus Leave](../scripting/class/event-on-focus-leave.md) and [Event On Focus Activate](../scripting/class/event-on-focus-activate.md). Activate runs when the player presses the activate input while the element has focus.
- Graphs can read the **Focused** variable and call **Set Focus** and **Clear Focus**.
- Navigation keys and inputs are set in **Project Settings > Focus Navigation**.

## Related

- [Scene Layers](../scenes/scene-layers.md)
- [2D Button](2d-button.md)
- [Input](../input/index.md)
