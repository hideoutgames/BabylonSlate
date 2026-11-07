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
| Shading Mode | **2D**: lit by the scene's [2D Lights](light-2d.md), and unlit while the scene has none. **3D**: lit by 3D lights and environment lighting, like a Material surface. **Unlit**: always drawn as it is. Default **2D**. |
| Cast Shadows | Whether it casts a shadow in a lit world scene. Default off, because it is unlit. |

## Notes

- Use **3D** to light a 2D element in a 3D game. With **3D**, 2D Lights do not light it; with **2D**, 3D lights do not.
- Works in world scenes and in Scene Layers.
- Sorting Layers are listed back to front in **Project Settings > Game > Sorting Layers**. Layers further down the list draw in front.
- Sprites use cut-out transparency, so semi-transparent pixels do not blend.
- To animate a sprite, add an [Animation Graph](animation-graph.md) that plays a [Sprite Animation](../assets/sprite-animation.md).
- To make it solid, add a [Collider](collider.md) and a [Rigid Body](rigid-body.md).

## Related

- [Sprites](../2d/sprites.md)
- [2D](../2d/index.md)
