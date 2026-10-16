# Light

A point, spot or directional light that lights and shades the scene.

## Add it

Select an actor, then choose **Add Component > Rendering > Light**. You can also place a ready-made actor from **Place Actors > Lights**: **Point Light**, **Directional Light** or **Spot Light**.

## Settings

| Setting | Description |
| --- | --- |
| Enabled | Turns the light on or off. Default on. |
| Color | The light colour. Default white. |
| Intensity | Brightness, 0 to 16. Default 1. |
| Light Kind | **Point**, **Spot** or **Directional**. Default Point. |
| Cast Shadows | Casts shadows. Default off. |
| Shadow Priority | Which lights keep their shadows when the shadow budget is full. Default 0. |
| Range | Distance the light reaches. Not for Directional. Default 10. |
| Inner Angle | Spot only. Full-strength cone, in degrees. Default 30. |
| Outer Angle | Spot only. Edge of the cone, in degrees. Default 45. |

## Notes

- World scenes only.
- Spot and directional lights shine along the actor's forward (+Z) axis. Rotate the actor to aim them.
- Only the first enabled directional light in a scene lights it. Others stay off.
- The viewport icon shows the state. White works as set, yellow is limited, and red is disabled or not lighting.
- Scripts can use [Set Light Enabled](../scripting/class/set-light-enabled.md), [Set Light Color](../scripting/class/set-light-color.md) and [Set Light Intensity](../scripting/class/set-light-intensity.md).

## Related

- [Lighting](../graphics/lighting.md)
- [Shadows](../graphics/shadows.md)
- [Hemispheric Fill Light](hemispheric-fill-light.md)
