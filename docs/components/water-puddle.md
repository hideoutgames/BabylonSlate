# Water Puddle

A shallow oval of water with small ripples.

## Add it

Select an actor, then choose **Add Component > Water > Water Puddle**. You can also place a ready-made actor from **Place Actors > Water > Water Puddle**.

## Settings

| Setting | Description |
| --- | --- |
| Water | The [Water](../assets/water.md) asset that sets the look and waves. Empty uses the Realistic defaults. |
| Enabled | Draws the water and includes it in water queries and buoyancy. Default on. |
| Width | Size along local X, 0.1 to 10,000. Default 3. |
| Length | Size along local Z, 0.1 to 10,000. Default 2. |
| Depth | Depth of the water below the surface, 0.01 to 10,000. Default 0.1. |
| Wave Scale | Multiplies the asset's waves, 0 to 10. Default 0.03. |
| Flow Speed | Speed of the current, -100 to 100. Default 0. |
| Flow Direction | Direction of the current, in degrees. Default 0. |
| Surface Resolution | Mesh detail, 8 to 128. Default 48. |

## Notes

- World scenes only.
- The edge of the water is an oval set by Width and Length.
- Select the actor to show handles you drag to change Width, Length and Depth. If the actor has several shapes, choose **Edit In Viewport** on the component to pick the one to edit.
- A puddle is shallow, so its Depth limits how much it can buoy up an object.

## Related

- [Water](../graphics/water.md)
- [Water Buoyancy](water-buoyancy.md)
