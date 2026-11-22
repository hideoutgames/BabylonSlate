# Decal

Projects a Decal Material onto underlying opaque world surfaces inside an oriented box volume without duplicating base textures or splitting geometry.

## Add it

Select an actor, then choose **Add Component > Rendering > Decal**. You can also place a ready-made actor from **Place Actors > Environment > Decal**. Then pick a **Material**.

## Settings

| Setting | Description |
| --- | --- |
| Enabled | Turns the decal on or off. Default on. |
| Material | A Material or Material Instance of the **Decal** domain. Its graph decides the decal's look: colour, textures, opacity, normal, roughness, Shading Model (lit or unlit) and Blend Mode. Nothing draws without one. |
| Tint | Colour multiplied with the Material's Base Color and Emissive, for this decal only. Default white. |
| Opacity | Multiplies the Material's Opacity for this decal, 0 to 1. Default 1. |
| Size | Full local projection box extents (X width, Y projection depth, Z height), in scene units. The decal projects along local **-Y**. Default 2, 1, 2. |
| Fade Angle | Angle in degrees, 1 to 180, between a surface's normal and the decal's local **+Y** beyond which the decal smoothly fades out. Below 90 it keeps to surfaces facing the projector; above 90 it also reaches surfaces facing away from it, such as both sides of a thin wall; 180 never fades. Default 75. |
| Sort Order | Higher values draw on top of lower-order overlapping decals. Default 0. |
| Cull Distance | Distance from the camera beyond which the decal stops drawing, scaled by Geometry quality. 0 never culls by distance. Default 0. |

## Make a Decal Material

1. In the **Content Browser**, create a **Material** and set its **Domain** to **Decal** in the **Inspector**, or choose **New Material** in the Decal's **Material** picker.
2. Wire nodes into its [Decal Output](../scripting/material/decal-output.md). [UV](../scripting/material/uv.md) gives the decal's projected coordinates, so a [Texture Sample](../scripting/material/texture-sample.md) with its UV unconnected covers the box once.
3. Choose its **Shading Model** and **Blend Mode**: **Opaque**, **Masked**, **Translucent**, **Additive** or **Multiply**. The preview projects the Material onto a floor and a ball.

Decals of one Material draw together, whatever their Tint and Opacity. A [Material Instance](../assets/material-instance.md) of a Decal Material shares its parent's shader and draws in its own group.

## Notes

- World scenes only.
- Projects along the component's local **-Y** axis (indicated by the arrow inside the editor wireframe box), onto surfaces facing back up its **+Y**. Any rotation works, including upside down onto a ceiling, and a negative actor scale mirrors the decal.
- Decals project onto opaque and alpha-tested geometry (floors, walls, meshes and landscapes) and draw before transparent meshes and water.
- Decals show in the Scene viewport, Prefab previews and Play. A decal whose Material is still compiling appears as soon as it is ready.
- Decals stay in place with **Large World Rendering** on.
- Mirrors, Reflection Probes and planar water reflections do not show decals.
- For runtime effects such as bullet impacts or footprints, use [Spawn Decal](../scripting/class/spawn-decal.md).

## Related

- [Spawn Decal](../scripting/class/spawn-decal.md)
- [Decal Output](../scripting/material/decal-output.md)
- [Material](../assets/material.md)
- [Fog Volume](fog-volume.md)
