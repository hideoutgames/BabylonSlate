# Hemispheric Fill Light

Soft fill light with one colour from above and another from below. It never casts shadows.

## Add it

Select an actor, then choose **Add Component > Rendering > Hemispheric Fill Light**. You can also place a ready-made actor from **Place Actors > Lights > Hemispheric Fill**.

## Settings

| Setting | Description |
| --- | --- |
| Enabled | Turns the light on or off. Default on. |
| Color | The colour of light from above. Default white. |
| Ground Color | The colour of light from below. Default black. |
| Intensity | Brightness, 0 to 16. Default 0.9. |

## Notes

- World scenes only.
- Fill light lifts areas that direct lights do not reach. For lighting from a sky image, use [environment lighting](../graphics/lighting.md#environment-lighting).
- Fill lights use their own slots and do not count toward the local light budget.
- Fill lights do not light volumetric fog.

## Related

- [Lighting](../graphics/lighting.md)
- [Light](light.md)
