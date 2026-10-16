# Rectangular Area Light

A rectangular emitter for windows, screens and light panels. It does not cast shadows.

## Add it

Select an actor, then choose **Add Component > Rendering > Rectangular Area Light**.

## Settings

| Setting | Description |
| --- | --- |
| Enabled | Turns the light on or off. Default on. |
| Width | Width of the emitter in local units. Default 1. |
| Height | Height of the emitter in local units. Default 1. |
| Color | The light colour. Default white. |
| Intensity | Brightness. Default 1. |
| Emission Texture | A Texture the emitter shows. Empty emits a uniform colour. |

## Notes

- World scenes only.
- The light emits along the component's forward (+Z) axis. It lights through walls, because it casts no shadows.
- Actor and parent scale apply to Width and Height. Sheared transforms are not supported.
- To use an Emission Texture, open the Texture asset and choose **Prepare Emission**. A Texture that has not been prepared cannot be loaded for Play or export.
- The emitter counts toward the local light budget.

## Related

- [Lighting](../graphics/lighting.md)
- [Texture](../assets/texture.md)
