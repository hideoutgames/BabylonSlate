# Foliage

Holds the instances of trees, grass and rocks that you paint onto surfaces in the viewport.

## Create it

A Foliage component is created by painting, not through **Add Component** or **Place Actors**.

1. Open a world scene and set **Scene Mode** to **Foliage**.
2. In **Foliage Groups**, choose **New Group**, then **Add Model** for each Model the group scatters.
3. Pick **Paint Foliage** in the viewport toolbar and drag across a surface.

Each stroke adds an actor named after the group, such as **Foliage Group 1 Stroke**, with a Foliage component that holds the painted instances. **Erase Foliage** removes instances inside the brush.

## Group settings

| Setting | Description |
| --- | --- |
| Weight | How often this Model is chosen, 0 to 100. Default 1. |
| Scale Range | Minimum and maximum scale for each instance. Default 0.8 to 1.2. |
| Material Override | A Material to use instead of the Model's own. |
| Cull Distance | Distance from the camera, in meters, at which this Model's foliage stops drawing. 0 never culls. Default 120. |
| Fade Range | Width, in meters, of the dithered fade-out that ends at **Cull Distance**. Default 15. |
| Shadow Distance | Distance from the camera, in meters, beyond which this Model's foliage stops casting shadows. 0 follows **Cull Distance**. Default 45. |

**Material Override**, **Cull Distance**, **Fade Range** and **Shadow Distance** also change the strokes already painted with the Model.

## Brush settings

In **Foliage Settings**:

| Setting | Description |
| --- | --- |
| Radius | Brush size. Default 4. |
| Density | Instances per square unit. Default 0.25. |
| Minimum Spacing | Smallest gap between instances. Default 0.5. |
| Maximum Slope | Steepest surface that receives foliage, in degrees. Default 60. |
| Align To Surface | Tilts each instance to the surface. Default on. |
| Random Rotation | Turns each instance by a random angle around the up axis. Default on. |

## Notes

- World scenes only.
- A Foliage component holds up to 20,000 instances. Paint more strokes for more.
- In Play, foliage fades out and stops drawing past **Cull Distance**, and stops casting shadows past **Shadow Distance**. The project's **LOD Distance Scale** multiplies all three distances. Distances count from the area of foliage nearest the camera, so nearby instances share one decision.
- The editor viewport always shows all foliage, however far the camera, so you can select and erase every stroke.
- Foliage switches to the Model's simpler levels with distance when the project's **Auto LOD** is on ([Automatic LOD](../graphics/models.md#automatic-lod)).
- Mirrors, Reflection Probes and Render Targets show the foliage the main camera shows, even when they look elsewhere.
- Foliage lands on any visible surface the brush can hit, such as a [Landscape](landscape.md) or a [Mesh](mesh.md).

## Related

- [Landscape and Foliage](../scenes/landscape.md)
- [Model](../assets/model.md)
