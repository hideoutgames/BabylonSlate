# Global Water Volume

Water that reaches the horizon, with detail that follows the camera.

## Add it

Select an actor, then choose **Add Component > Water > Global Water Volume**. You can also place a ready-made actor from **Place Actors > Water > Global Water Volume**.

## Settings

| Setting | Description |
| --- | --- |
| Water | The [Water](../assets/water.md) asset that sets the look and waves. Empty uses the Realistic defaults. |
| Enabled | Draws the water and includes it in water queries and buoyancy. Default on. |
| Depth | Depth of the water below the surface, 0.01 to 10,000. Default 1000. |
| Wave Scale | Multiplies the asset's waves, 0 to 10. Default 1. |
| Flow Speed | Speed of the current, -100 to 100. Default 0. |
| Flow Direction | Direction of the current, in degrees. Default 0. |
| Surface Resolution | Mesh detail, 8 to 128. Default 96. |

## Notes

- World scenes only.
- It has no Width or Length. The surface extends to the horizon and the mesh detail follows the camera.
- The actor's height sets the water level. Select the actor to show a handle that you drag to change Depth.
- To cut a hole in it, such as inside a boat hull, use a [Water Removal Volume](water-removal-volume.md).
- Use [Water Ocean](water-ocean.md) when you want a bounded rectangle.

## Related

- [Water](../graphics/water.md)
- [Water Buoyancy](water-buoyancy.md)
