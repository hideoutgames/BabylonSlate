# Material

A node graph that decides how a surface, landscape, particle, piece of text or full-screen pass looks.

## Create

In the **Content Browser**, choose **New Asset > Rendering > Material**.

Or select Textures, right-click one and choose **Create Material**. Textures named like `Rock_albedo`, `Rock_normal` and `Rock_rough` make one Material with each wired to its input. See [Create from assets](../editor/content-browser.md#create-from-assets).

## Editor

Double-tap a Material to open it.

- **Graph**: place nodes with **Add Node** and wire them into the output node for the Material's domain. **Format** in the graph toolbar lays out what feeds the output, flowing in from the left ([Format](../scripting/index.md#format)).
- **Preview**: the Material on a shape. Pick **Cube**, **Sphere**, **Cylinder**, **Cone**, **Plane** or **Custom** to preview on one of your Models. A key light from the upper right and a soft fill light the shape, as they light thumbnails. The default sky behind the shape also lights it, so metallic and glossy Materials reflect it.
- **Inspector**: the Material's settings, or the selected node's properties. With several nodes selected, it shows the properties and input defaults they all have, such as **A** and **B** for an **Add** and a **Multiply**, with **Mixed Values** where they differ. An edit changes every selected node, and typing a sum such as `Mixed Values+4` changes each from its own value ([multi-selection](../start/editor-tour.md#scene-panels)).
- **Compiler Results**: problems with the graph. Tap one to jump to its node, or double-tap it to also bring **Graph** forward. Right-click or hold one to copy it.

Simple graphs refresh the Preview as you edit. For expensive graphs, Custom GLSL and post-process Materials, choose **Render** in the toolbar. With no node selected, the Inspector also shows the graph's cost: operations and texture samples.

## Preview a node

To see what one node outputs, right-click or hold it in the graph and choose **Preview Node**. For a node with several outputs, such as a **Texture Sample**, pick the output from the **Preview Node** submenu. With a keyboard, select one node and press <kbd>P</kbd>: it previews the node's first output, and pressing it again stops. The key does nothing while several nodes are selected ([Keyboard Shortcuts](../start/shortcuts.md#material)).

While a node is previewed:

- The Preview shows that output alone, unlit, instead of the Material. A Float is grey, a Vector2 shows X as red and Y as green, and a Vector4 or RGBA output shows its first three channels.
- An amber bar above the Preview reads **Previewing Node:** and the node's name, and an amber frame surrounds the shape. The node has an amber outline and a **Previewing** tag in the graph.
- The Preview keeps following your edits to the graph. The Inspector's cost is still the whole Material's.

To return to the Material, choose **Stop Previewing** in the bar, or **Stop Previewing Node** from the menu of the previewed node or the output node. Deleting the previewed node also stops it. Previewing a node does not change the Material: it is not saved and is not an undo step. Texture outputs cannot be previewed, and Material Functions, which have no Preview, do not offer **Preview Node**.

## Named Reroutes

A Named Reroute carries a value across the graph by name instead of by a long wire.

1. In **Add Node**, choose **Create Named Reroute…** (under **Reroute**). The new node is named **Reroute**, **Reroute_1** and so on, and its title opens for renaming. Type a name and press <kbd>Enter</kbd>.
2. Wire any value into its **In** pin, Textures included.
3. To read the value elsewhere, search **Add Node** for the reroute's name and add it. The usage node outputs whatever is wired into the Named Reroute, as if wired straight from it.

- Each name has exactly one [Named Reroute](../scripting/material/named-reroute.md) and any number of [usages](../scripting/material/named-reroute-usage.md). Names are unique: a taken name gets **_1**, **_2** and so on, including on copied and pasted reroutes.
- Rename a reroute by double-clicking its title, with **Rename** in its menu, or in the **Inspector**'s **Name**. Every usage takes the new name.
- Its **Color** in the **Inspector** colours the headers of the reroute and all its usages.
- Double-click a usage, or choose **Select Declaration** in its menu, to go to its Named Reroute.
- A usage that feeds back into its own Named Reroute, directly or through other nodes and reroutes, is an error in **Compiler Results**. So is a usage whose Named Reroute was deleted, which shows **Missing Reroute**.
- Named Reroutes belong to one graph: a Material's are not visible in a Material Function, and each Material Function has its own.
- Reroutes cost nothing: the Material compiles as if the wires were direct.

## Settings

With no node selected, the **Inspector** shows these settings. Some apply to only some domains.

| Setting | Description |
| --- | --- |
| Domain | **Surface** (meshes and models), **Landscape**, **Post Process** (full-screen passes), **Particle**, **Text** (2D text in Scene Layers) or **Decal** (projected by a [Decal](../components/decal.md) or [Spawn Decal](../scripting/class/spawn-decal.md)). Changing it removes nodes the new domain does not support; between Surface and Decal the output node keeps the wires both outputs have. |
| Shading Model | **PBR** (lit) or **Unlit**. Surface, Landscape and Decal. |
| Blend Mode | **Opaque**, **Masked**, **Translucent**, **Additive** or **Multiply** (Surface, Landscape and Decal): Multiply darkens what is behind by the colour, scaled by Opacity. A Multiply Material on a Scene Layer draws as Translucent. Text offers Translucent and Additive. Not shown for Particle or Text; particle emitters set their own blending. |
| Alpha Cutoff | Masked only. Pixels with lower opacity are cut out. Under [MSAA](../graphics/post-processing.md#anti-aliasing) the cut-out edges are smoothed (not on decals). |
| Two Sided | Draws back faces too. Surface and Landscape. |
| Default Normals | **Model Normals** or **Flat Normals**, used when the Normal input is unconnected. Surface and Landscape. |
| Bounds Padding (Local) | Enlarges culling bounds for Materials that move vertices, so displaced meshes do not vanish at screen edges. Surface and Landscape. |

Each domain has its own output node: [Material Output](../scripting/material/material-output.md) for Surface and Landscape, [Post Process Output](../scripting/material/post-process-output.md), [Particle Output](../scripting/material/particle-output.md), [Text Output](../scripting/material/text-output.md) and [Decal Output](../scripting/material/decal-output.md).

A Decal Material previews projected onto a floor and a ball. In its graph, [UV](../scripting/material/uv.md) gives the decal's projected coordinates and World Position and World Normal the surface under it. A Per Instance parameter is an ordinary parameter in a Decal Material: each decal's own Tint and Opacity are its per-decal values.

## Notes

- Add a [Float Parameter](../scripting/material/float-parameter.md), [Vector2 Parameter](../scripting/material/vector2-parameter.md), [Vector3 Parameter](../scripting/material/vector3-parameter.md), [Vector4 Parameter](../scripting/material/vector4-parameter.md), [Color Parameter](../scripting/material/color-parameter.md) or [Texture Parameter](../scripting/material/texture-parameter.md) to expose a value to Material Instances and scripts.
- Assign a Material to a [Mesh component's](../components/mesh.md) **Material** field.
- In CEL projects, lit Surface Materials switch to CEL lighting automatically.

## Related

- [Materials](../graphics/materials.md)
- [Material Instance](material-instance.md)
- [Material Function](material-function.md)
- [Material nodes](../scripting/material/index.md)
