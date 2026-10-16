# Outline

Draws a coloured silhouette around an actor, with its own colour, width and visibility.

## Add it

Select an actor, then choose **Add Component > Rendering > Outline**.

## Settings

| Setting | Description |
| --- | --- |
| Enabled | Shows the outline. Turning it off reveals any global CEL outline that applies. Default on. |
| Color | The outline colour. Default near black. |
| Width | Width in screen pixels, 0.25 to 8. It does not change with the actor's scale. Default 1. |
| Render Through Meshes | Shows the outline through other geometry, for example to highlight a target behind a wall. Default off. |

## Notes

- World scenes only.
- The outline follows the geometry of the actor it is on, such as a [Mesh](mesh.md).
- Global CEL outlines stay hidden behind other geometry. Only this component can draw through meshes.
- For outlines on every object in a CEL project, use the project's CEL Shading settings.

## Related

- [Lighting](../graphics/lighting.md#cel-shading)
- [Geometry](../graphics/geometry.md)
