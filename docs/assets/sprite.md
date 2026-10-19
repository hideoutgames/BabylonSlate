# Sprite

A 2D image built from a Texture: size, pivot and optional collision.

## Create

In the **Content Browser**, choose **New Asset > 2D > Sprite**. Import your image first, so you can pick it as a Texture. See [Importing](../editor/importing.md).

## Editor

Double-tap a Sprite to open it.

- **Preview**: the frame at its own proportions with a crosshair at the pivot and a dashed box for the collision. Drag to move the view; pinch or use the mouse wheel to zoom. **Fit** and **Actual Size** return to their view. With **Collision** on, drag the box or its handles to change it: edges snap to whole pixels and the position and size show in pixels while you drag. **Reset Collision** makes the box cover the whole image again; turn **Collision** off to hide the box.
- **Inspector**: the Sprite's settings.

## Settings

| Setting | Description |
| --- | --- |
| Texture | The image to show. |
| Pixels Per Unit | Image pixels per world unit, which sets the sprite's size in the world. Default 100. |
| Pivot | The point of the image that sits at the actor's position, as fractions of the image. 0.5, 0.5 is the centre and 0, 0 the top-left corner. |
| Frame Duration | Length of the frame in milliseconds. Default 100. |
| Collision | The collision box as fractions of the image: X, Y, W and H. The default covers the whole image. |

## Notes

- With **Pixel-Perfect Mode** on (**Project Settings > Game > 2D**), sprites sample their Texture with nearest-neighbour filtering, so pixel art stays sharp.
- A [Collider](../components/collider.md) with the **Box 2D** shape takes its size and position from the Sprite's collision box and pivot.
- To play several images in turn, use a [Sprite Animation](sprite-animation.md).

## Related

- [Sprites](../2d/sprites.md)
- [Sprite component](../components/sprite.md)
- [Sprite Animation](sprite-animation.md)
- [Texture](texture.md)
