# Tilemap

Draws a Tilemap asset: a grid of tiles, with optional collision.

## Add it

Select an actor, then choose **Add Component > Rendering > Tilemap**. You can also place a ready-made actor from **Place Actors > Rendering > Tilemap**. Tilemap assets in your project also appear in **Place Actors** and arrive already assigned.

## Settings

| Setting | Description |
| --- | --- |
| Asset | The [Tilemap](../assets/tilemap.md) to draw. |
| Sorting Layer | The layer the tilemap draws on. Default **Default**. |
| Order In Layer | Order within the layer. Higher values draw in front. Default 0. |

## Notes

- Works in world scenes and in Scene Layers.
- The Sorting Layer and Order In Layer apply to the whole tilemap. Inside it, the asset's own layers keep their order.
- Sorting Layers are listed back to front in **Project Settings > Game > Sorting Layers**. Layers further down the list draw in front.
- In Play the tilemap becomes a static body, so it needs no Rigid Body. Only tiles whose **Tile Collision** is **Full** or **Chain** in the [Tileset](../assets/tileset.md), on layers that have **Collision** turned on in the Tilemap asset, collide. Tiles left on **None** stay passable.
- Paint tiles by opening the Tilemap asset.

## Related

- [Tilemaps](../2d/tilemaps.md)
- [Tileset](../assets/tileset.md)
- [2D](../2d/index.md)
