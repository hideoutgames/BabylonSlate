# 2D Panel

A stretchable background that keeps its corners and edges intact at any size, built from a Texture or a Material.

## Add it

Select an actor in a Scene Layer, then choose **Add Component > Overlay > 2D Panel**. You can also place a ready-made actor from **Place Actors > Overlay > 2D Panel**.

## Settings

| Setting | Description |
| --- | --- |
| Source | Texture (default) or Material. Decides which picker shows below. |
| Texture or Material | The [Texture](../assets/texture.md) to slice, or the [Material](../assets/material.md) or Material Instance to draw. |
| Margin Left, Margin Right, Margin Top, Margin Bottom | How much of each edge of the source stays unstretched, from 0 to 1. 0.5 is half of that edge. Default 0. |
| Hit Test | Whether taps hit the panel. Ignore (default) lets them pass through. Block takes the tap and stops it. Pass Through takes it and lets it continue to what is behind. |

The Inspector also shows a preview of the source with the margins marked as dashed lines. Drag the sliders and watch the lines move.

## Notes

- Scene Layers only.
- The margins cut the source into nine parts. The corners keep their size when you resize the panel, the edges stretch along one direction, and the centre stretches both ways.
- If the panel becomes smaller than its margins, the margins shrink to fit.
- Resize the panel with the box around the actor in the viewport. The panel is unlit.
- The component has **Opacity** and **Tint** variables for graphs. Animate them with [Tween 2D Opacity](../scripting/class/tween-2d-opacity.md) and [Tween 2D Tint](../scripting/class/tween-2d-tint.md).
- Add a [2D Button](2d-button.md) to the same actor to make the panel clickable.

## Related

- [Scene Layers](../scenes/scene-layers.md)
- [2D Texture](2d-texture.md)
- [2D Material](2d-material.md)
