# Decal

Projects a texture onto underlying opaque world surfaces inside an oriented box volume without duplicating base textures or splitting geometry.

## Add it

Select an actor, then choose **Add Component > Rendering > Decal**. You can also place a ready-made actor from **Place Actors > Environment > Decal**.

## Settings

| Setting | Description |
| --- | --- |
| Enabled | Turns the decal on or off. Default on. |
| Texture | RGBA Texture projected onto world surfaces. Alpha controls coverage. |
| Normal Texture | Optional tangent-space normal map blended over the underlying surface normal when **Receive Lighting** is on. |
| Tint | Colour multiplied with the texture. Default white. |
| Opacity | Overall opacity multiplier, 0 to 1. Default 1. |
| Roughness | Surface roughness for direct and environment reflections when **Receive Lighting** is on. Default 0.7. |
| Blend Mode | **Alpha**, **Multiply** or **Additive**. Default Alpha. |
| Receive Lighting | Shades the decal with scene lights, shadows and environment lighting. Default on. |
| Size | Full local projection box extents (X width, Y projection depth, Z height), in scene units. Default 2, 1, 2. |
| Fade Angle | Angle in degrees from local +Y beyond which the decal smoothly fades out on steep surfaces. Default 75. |
| Sort Order | Higher values draw on top of lower-order overlapping decals. Default 0. |
| Cull Distance | Distance from the camera beyond which the decal stops drawing, scaled by Geometry quality. 0 never culls by distance. Default 0. |

## Notes

- World scenes only.
- Projects along the component's local **-Y** axis (indicated by the arrow inside the editor wireframe box).
- Decals project onto opaque and alpha-tested geometry (floors, walls, meshes and landscapes) and draw before transparent meshes and water.
- For runtime effects such as bullet impacts or footprints, use [Spawn Decal](../scripting/class/spawn-decal.md).

## Related

- [Spawn Decal](../scripting/class/spawn-decal.md)
- [Fog Volume](fog-volume.md)
