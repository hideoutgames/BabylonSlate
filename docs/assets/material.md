# Material

A node graph that decides how a surface, landscape, particle, piece of text or full-screen pass looks.

## Create

In the **Content Browser**, choose **New Asset > Rendering > Material**.

## Editor

Double-tap a Material to open it.

- **Graph**: place nodes with **Add Node** and wire them into the output node for the Material's domain.
- **Preview**: the Material on a shape. Pick **Cube**, **Sphere**, **Cylinder**, **Cone**, **Plane** or **Custom** to preview on one of your Models.
- **Inspector**: the Material's settings, or the selected node's properties.
- **Compiler Results**: problems with the graph. Tap one to jump to its node.

Simple graphs refresh the Preview as you edit. For expensive graphs, Custom GLSL and post-process Materials, choose **Render** in the toolbar. With no node selected, the Inspector also shows the graph's cost: operations and texture samples.

## Settings

With no node selected, the **Inspector** shows these settings. Some apply to only some domains.

| Setting | Description |
| --- | --- |
| Domain | **Surface** (meshes and models), **Landscape**, **Post Process** (full-screen passes), **Particle** or **Text** (2D text in Scene Layers). Changing it removes nodes the new domain does not support. |
| Shading Model | **PBR** (lit) or **Unlit**. Surface and Landscape. |
| Blend Mode | **Opaque**, **Masked**, **Translucent** or **Additive**. Not shown for Particle or Text; particle emitters set their own blending. |
| Alpha Cutoff | Masked only. Pixels with lower opacity are cut out. |
| Two Sided | Draws back faces too. Surface and Landscape. |
| Default Normals | **Model Normals** or **Flat Normals**, used when the Normal input is unconnected. Surface and Landscape. |
| Bounds Padding (Local) | Enlarges culling bounds for Materials that move vertices, so displaced meshes do not vanish at screen edges. Surface and Landscape. |

Each domain has its own output node: [Material Output](../scripting/material/material-output.md) for Surface and Landscape, [Post Process Output](../scripting/material/post-process-output.md), [Particle Output](../scripting/material/particle-output.md) and [Text Output](../scripting/material/text-output.md).

## Notes

- Add a [Float Parameter](../scripting/material/float-parameter.md), [Color Parameter](../scripting/material/color-parameter.md) or [Texture Parameter](../scripting/material/texture-parameter.md) to expose a value to Material Instances and scripts.
- Assign a Material to a [Mesh component's](../components/mesh.md) **Material** field.
- In CEL projects, lit Surface Materials switch to CEL lighting automatically.

## Related

- [Materials](../graphics/materials.md)
- [Material Instance](material-instance.md)
- [Material Function](material-function.md)
- [Material nodes](../scripting/material/index.md)
