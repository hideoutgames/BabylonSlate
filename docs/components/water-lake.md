# Water Lake

A bounded oval of water with gentle waves.

## Add it

Select an actor, then choose **Add Component > Water > Water Lake**. You can also place a ready-made actor from **Place Actors > Water > Water Lake**. Placing a Water asset from the **Place Actors** list creates a lake that already uses it.

## Settings

| Setting | Description |
| --- | --- |
| Water | The [Water](../assets/water.md) asset that sets the look and waves. Empty uses the Realistic defaults. |
| Enabled | Draws the water and includes it in water queries and buoyancy. Default on. |
| Width | Size along local X, 0.1 to 10,000. Default 30. |
| Length | Size along local Z, 0.1 to 10,000. Default 30. |
| Depth | Depth of the water below the surface, 0.01 to 10,000. Default 5. |
| Wave Scale | Multiplies the asset's waves, 0 to 10. Default 0.35. |
| Flow Speed | Speed of the current, -100 to 100. Default 0. |
| Flow Direction | Direction of the current, in degrees. Default 0. |
| Surface Resolution | Mesh detail, 8 to 128. Default 48. |

## Notes

- World scenes only.
- The edge of the water is an oval set by Width and Length.
- Select the actor to show handles you drag to change Width, Length and Depth. If the actor has several shapes, choose **Edit In Viewport** on the component to pick the one to edit.
- Water bodies that are close together merge into one surface. See Water Blend Distance in [Water](../graphics/water.md).
- To float an object on it, add [Water Buoyancy](water-buoyancy.md).

## Related

- [Water](../graphics/water.md)
- [Water River](water-river.md)
