# Water Ocean

A large rectangle of water with broad waves.

## Add it

Select an actor, then choose **Add Component > Water > Water Ocean**. You can also place a ready-made actor from **Place Actors > Water > Water Ocean**.

## Settings

| Setting | Description |
| --- | --- |
| Water | The [Water](../assets/water.md) asset that sets the look and waves. Empty uses the Realistic defaults. |
| Enabled | Draws the water and includes it in water queries and buoyancy. Default on. |
| Width | Size along local X, 0.1 to 10,000. Default 256. |
| Length | Size along local Z, 0.1 to 10,000. Default 256. |
| Depth | Depth of the water below the surface, 0.01 to 10,000. Default 1000. |
| Wave Scale | Multiplies the asset's waves, 0 to 10. Default 1. |
| Flow Speed | Speed of the current, -100 to 100. Default 0. |
| Flow Direction | Direction of the current, in degrees. Default 0. |
| Surface Resolution | Mesh detail, 8 to 128. Default 96. |

## Notes

- World scenes only.
- Select the actor to show handles you drag to change Width, Length and Depth. If the actor has several shapes, choose **Edit In Viewport** on the component to pick the one to edit.
- Waves are measured in world units, so scaling the actor does not stretch them.
- To float an object on it, add [Water Buoyancy](water-buoyancy.md). To cut a hole in it, use a [Water Removal Volume](water-removal-volume.md).
- [Sample Water Surface](../scripting/class/sample-water-surface.md) reads the height and current at a position.

## Related

- [Water](../graphics/water.md)
- [Water asset](../assets/water.md)
