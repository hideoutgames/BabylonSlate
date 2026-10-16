# Water River

Water that follows a path of points, with a current along the path.

## Add it

Select an actor, then choose **Add Component > Water > Water River**. You can also place a ready-made actor from **Place Actors > Water > Water River**.

## Settings

| Setting | Description |
| --- | --- |
| Water | The [Water](../assets/water.md) asset that sets the look and waves. Empty uses the Realistic defaults. |
| Enabled | Draws the water and includes it in water queries and buoyancy. Default on. |
| Width | River width in units, 0.1 to 10,000. Default 6. |
| Depth | Depth of the water below the surface, 0.01 to 10,000. Default 5. |
| Wave Scale | Multiplies the asset's waves, 0 to 10. Default 0.15. |
| Flow Speed | Speed of the current along the path, -100 to 100. Default 1.5. |
| Surface Resolution | Mesh detail, 8 to 128. Default 48. |
| Curvature | 0 joins points with straight reaches. 1 bends the river smoothly through every point. Default 1. |
| Path Point Count | Number of points, 2 to 128. Default 2. |
| Path Point 1, 2, ... | The position of each point in local space, from upstream to downstream. Y sets the water level. |
| Path Point 1, 2, ... Width Scale | Multiplies Width at that point, 0.05 to 20. Default 1. |

## Edit in the viewport

Select the actor to show the river's handles. If the actor has several shapes, choose **Edit In Viewport** on the component to pick the one to edit.

- Drag a point to move it. Drag an orange handle to change the width at that point.
- Drag the handle at the middle of a reach to add a point.
- Double-click a point to remove it. A river keeps at least two.

## Notes

- World scenes only.
- Flow Direction does not apply. The current follows the path.
- Water bodies that are close together merge into one surface. See Water Blend Distance in [Water](../graphics/water.md).

## Related

- [Water](../graphics/water.md)
- [Spline](spline.md) uses the same path controls.
