# Sprite

Draws a 2D image from a Sprite asset on a flat quad.

## Add it

Select an actor, then choose **Add Component > Rendering > Sprite**. You can also place a ready-made actor from **Place Actors > Rendering > Sprite**.

## Settings

| Setting | Description |
| --- | --- |
| Asset | The [Sprite](../assets/sprite.md) to draw. |
| Sorting Layer | The layer the sprite draws on. Default **Default**. |
| Order In Layer | Order within the layer. Higher values draw in front. Default 0. |

## Notes

- Works in world scenes and in Scene Layers.
- Sorting Layers are listed back to front in **Project Settings > Game > Sorting Layers**. Layers further down the list draw in front.
- Sprites use cut-out transparency, so semi-transparent pixels do not blend.
- To animate a sprite, add an [Animation Graph](animation-graph.md) that plays a [Sprite Animation](../assets/sprite-animation.md).
- To make it solid, add a [Collider](collider.md) and a [Rigid Body](rigid-body.md).

## Related

- [Sprites](../2d/sprites.md)
- [2D](../2d/index.md)
