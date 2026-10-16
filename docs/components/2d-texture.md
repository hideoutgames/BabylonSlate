# 2D Texture

Draws a Texture as a flat image on a Scene Layer.

## Add it

Select an actor in a Scene Layer, then choose **Add Component > Overlay > 2D Texture**. You can also place a ready-made actor from **Place Actors > Overlay > 2D Texture**.

## Settings

| Setting | Description |
| --- | --- |
| Texture | The [Texture](../assets/texture.md) to draw. |
| Hit Test | Whether taps hit the image. Ignore (default) lets them pass through. Block takes the tap and stops it. Pass Through takes it and lets it continue to what is behind. |

## Notes

- Scene Layers only.
- There is no size setting. The image is as large as the Texture's pixels divided by **Pixels Per Unit** (**Project Settings > Game > 2D**, default 100), multiplied by the actor's scale. Resize it with the box around the actor in the viewport. With no Texture it is one unit square.
- Inside a box, such as a [2D Vertical Box](2d-vertical-box.md), the box sizes and places the image. A box with Stretch alignment stretches it to fit.
- The image is unlit, so lights have no effect on it.
- The component has **Opacity** and **Tint** variables for graphs. Animate them with [Tween 2D Opacity](../scripting/class/tween-2d-opacity.md) and [Tween 2D Tint](../scripting/class/tween-2d-tint.md).
- Add a [2D Button](2d-button.md) to the same actor to make the image clickable. Without one, the image receives no click or hover events.
- For an image that stretches without distorting its corners, use a [2D Panel](2d-panel.md).

## Related

- [Scene Layers](../scenes/scene-layers.md)
- [Texture](../assets/texture.md)
- [2D Material](2d-material.md)
- [2D Panel](2d-panel.md)
