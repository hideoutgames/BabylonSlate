# 2D Material

Draws a Material as a flat square on a Scene Layer, for effects such as gradients, glows and animated shaders.

## Add it

Select an actor in a Scene Layer, then choose **Add Component > Overlay > 2D Material**. You can also place a ready-made actor from **Place Actors > Overlay > 2D Material**.

## Settings

| Setting | Description |
| --- | --- |
| Material | The [Material](../assets/material.md) or Material Instance to draw: a [User Interface](../graphics/materials.md#user-interface-materials) Material or an Instance of one. Materials of other domains are not listed, and are not drawn if a script sets one. |
| Hit Test | Whether taps hit the square. Ignore (default) lets them pass through. Block takes the tap and stops it. Pass Through takes it and lets it continue to what is behind. |

## Notes

- Scene Layers only.
- There is no size setting. The square is one unit across until you resize it with the box around the actor in the viewport.
- The Material is drawn unlit, so lights have no effect on it.
- The square is one element: [User Interface Input](../scripting/material/user-interface-input.md) gives its size in pixels on screen, and UV 0 to 1 across it.
- The component has **Opacity** and **Tint** variables for graphs, which multiply the Material's colour and opacity. Animate them with [Tween 2D Opacity](../scripting/class/tween-2d-opacity.md) and [Tween 2D Tint](../scripting/class/tween-2d-tint.md).
- Add a [2D Button](2d-button.md) to the same actor to make the square clickable.

## Related

- [Scene Layers](../scenes/scene-layers.md)
- [Materials](../graphics/materials.md)
- [2D Texture](2d-texture.md)
- [2D Panel](2d-panel.md)
