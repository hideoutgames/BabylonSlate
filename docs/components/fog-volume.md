# Fog Volume

A local box or sphere of fog with soft edges.

## Add it

Select an actor, then choose **Add Component > Rendering > Fog Volume**. You can also place a ready-made actor from **Place Actors > Environment > Fog Volume**.

## Settings

| Setting | Description |
| --- | --- |
| Enabled | Turns the fog on or off. Default on. |
| Shape | **Box** or **Sphere**. Default Box. |
| Size | Full width, height and depth along local X, Y and Z, in scene units. A sphere with unequal values stretches. Default 10, 10, 10. |
| Density | Fog added inside the volume. 0 adds none. Default 0.1. |
| Edge Falloff | Soft edge as a fraction of the half-size. 0 is a hard edge and 1 fades from the centre. Default 0.2. |

## Notes

- World scenes only.
- Actor and component scale also change the size.
- Overlapping volumes add their density. Up to eight nearby visible volumes contribute at once.
- A Fog Volume works without Scene-Wide Fog. Shared quality settings are in **Project Settings > Rendering > Post Processing**.

## Related

- [Sky and fog](../graphics/sky-and-fog.md)
