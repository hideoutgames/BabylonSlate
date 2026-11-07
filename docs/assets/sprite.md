# Sprite

A 2D image: one Texture with its pivot and collision box. To play several images in turn, use a [Sprite Animation](sprite-animation.md); its frames can be Sprites, which bring their pivot and collision box.

## Create

In the **Content Browser**, choose **New Asset > 2D > Sprite**. Import your image first, so you can pick it as a Texture. See [Importing](../editor/importing.md).

Or select one or more Textures, right-click one and choose **Convert to 2D > Create Sprite** (**Create Sprites** for several): each Texture gets a Sprite beside it. See [Create from assets](../editor/content-browser.md#create-from-assets).

## Editor

Double-tap a Sprite to open it.

- **Preview**: the frame at its own proportions with a crosshair at the pivot and a dashed box for the collision. Drag to move the view; pinch or use the mouse wheel to zoom. **Fit** and **Actual Size** return to their view. With **Collision** on, drag the box or its handles to change it: edges snap to whole pixels and the position and size show in pixels while you drag. **Reset Collision** makes the box cover the whole image again; turn **Collision** off to hide the box.
- **Inspector**: the Sprite's settings.

## Settings

| Setting | Description |
| --- | --- |
| Texture | The image to show. |
| Pixels Per Unit | Image pixels per world unit. The sprite's size in the world is its Texture's size divided by this. Default 100. |
| Pivot | The point of the image that sits at the actor's position, as fractions of the image. 0.5, 0.5 is the centre and 0, 0 the top-left corner. |
| Collision | The collision box as fractions of the image: X, Y, W and H. The default covers the whole image. |

## Notes

- Sprites sample their Texture with nearest-neighbour filtering, so pixel art stays sharp.
- A [Collider](../components/collider.md) with the **Box 2D** shape takes its size and position from the Sprite's collision box and pivot.
- A Sprite always shows its whole Texture. Re-importing the Texture at another size resizes the sprite.

## Related

- [Sprites](../2d/sprites.md)
- [Sprite component](../components/sprite.md)
- [Sprite Animation](sprite-animation.md)
- [Texture](texture.md)
