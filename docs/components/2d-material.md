# 2D Material

Draws a Material as a flat square on a Scene Layer, for effects such as gradients, glows and animated shaders.

## Add it

Select an actor in a Scene Layer, then choose **Add Component > Overlay > 2D Material**. You can also place a ready-made actor from **Place Actors > Overlay > 2D Material**.

## Settings

| Setting | Description |
| --- | --- |
| Material | The [Material](../assets/material.md) or Material Instance to draw. |
| Hit Test | Whether taps hit the square. Ignore (default) lets them pass through. Block takes the tap and stops it. Pass Through takes it and lets it continue to what is behind. |

## Notes

- Scene Layers only.
- There is no size setting. The square is one unit across until you resize it with the box around the actor in the viewport.
- The Material is drawn unlit, so lights have no effect on it.
- The component has **Opacity** and **Tint** variables for graphs. Animate them with [Tween 2D Opacity](../scripting/class/tween-2d-opacity.md) and [Tween 2D Tint](../scripting/class/tween-2d-tint.md).
- Add a [2D Button](2d-button.md) to the same actor to make the square clickable.

## Related

- [Scene Layers](../scenes/scene-layers.md)
- [Materials](../graphics/materials.md)
- [2D Texture](2d-texture.md)
- [2D Panel](2d-panel.md)
