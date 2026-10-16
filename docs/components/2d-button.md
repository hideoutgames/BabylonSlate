# 2D Button

Makes an actor react to taps, clicks, hover and keyboard or gamepad focus.

## Add it

Select an actor in a Scene Layer, then choose **Add Component > Overlay > 2D Button**. You can also place a ready-made actor from **Place Actors > Overlay > 2D Button**.

A button draws nothing itself. It uses the actor's visual as its tap area: a [2D Texture](2d-texture.md), [2D Material](2d-material.md), [2D Panel](2d-panel.md), [2D Text](2d-text.md) or [2D Rich Text](2d-rich-text.md) on the same actor, or on the parent actor when the button sits on a child. With no visual, it covers a one-unit square.

## Settings

| Setting | Description |
| --- | --- |
| Focus Enabled | Lets keyboard and gamepad navigation reach this button. Default on. |
| Initial Focus | Gives this button focus when the layer becomes active. Default off. |
| Focus Up, Focus Down, Focus Left, Focus Right | Which element receives focus in that direction. Automatic picks the nearest one. Or pick another focus target in the layer. A chosen target that is hidden or disabled stops navigation. |
| Hit Test | Block (default) takes the tap and stops it. Pass Through takes it and lets it continue to what is behind. Ignore lets it pass without counting. |

## Notes

- Scene Layers only.
- In a Scene Layer Actor class, the button adds [Event On Click](../scripting/class/event-on-click.md), [Event On Press Start](../scripting/class/event-on-press-start.md), [Event On Press End](../scripting/class/event-on-press-end.md), [Event On Mouse Enter](../scripting/class/event-on-mouse-enter.md) and [Event On Mouse Leave](../scripting/class/event-on-mouse-leave.md). They fire for mouse, touch and pen.
- A press that ends over the button is a click. Moving away before release cancels it.
- Focus adds [Event On Focus Enter](../scripting/class/event-on-focus-enter.md), [Event On Focus Leave](../scripting/class/event-on-focus-leave.md) and [Event On Focus Activate](../scripting/class/event-on-focus-activate.md), the read-only **Focused** variable, and the **Set Focus** and **Clear Focus** functions.
- The Hit Test value is also a variable, so a graph can change it. An actor with several buttons gets one set of events per button.
- Navigation keys and inputs are set in **Project Settings > Focus Navigation**.

## Related

- [Scene Layers](../scenes/scene-layers.md)
- [2D Focus Target](2d-focus-target.md)
- [2D Texture](2d-texture.md)
