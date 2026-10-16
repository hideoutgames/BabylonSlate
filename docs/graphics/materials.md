# Materials

A [Material](../assets/material.md) is a node graph that decides how a surface, particle, text or full-screen effect looks. [Material Instances](../assets/material-instance.md) reuse a Material with different parameter values, and [Material Functions](../assets/material-function.md) package node groups for reuse.

## Create a Material

1. In the **Content Browser**, create a **Material** (in the **Rendering** group of the New Asset dialog) and open it.
2. Choose **Add Node** in the graph and wire nodes into the output node, such as [Material Output](../scripting/material/material-output.md).
3. Check the result in **Preview**. Pick a preview shape (**Cube**, **Sphere**, **Cylinder**, **Cone**, **Plane**) or **Custom** to preview on one of your Models.
4. Save, then assign the Material to a [Mesh](../components/mesh.md) component's **Material** field.

Simple graphs refresh the preview as you edit. Expensive graphs, Custom GLSL and post-process Materials wait until you choose **Render** in the toolbar. Problems appear in **Compiler Results**; select one to jump to its node.

## Domains and settings

With no node selected, the **Inspector** shows the Material's settings.

| Domain | Use it for | Output node |
| --- | --- | --- |
| **Surface** | Meshes and models | [Material Output](../scripting/material/material-output.md) |
| **Landscape** | Landscapes, with paint-layer nodes | [Material Output](../scripting/material/material-output.md) |
| **Post Process** | Full-screen scene passes | [Post Process Output](../scripting/material/post-process-output.md) |
| **Particle** | The look of particle emitters | [Particle Output](../scripting/material/particle-output.md) |
| **Text** | 2D text in Scene Layers | [Text Output](../scripting/material/text-output.md) |

Changing the domain removes nodes the new domain does not support.

| Setting | Description |
| --- | --- |
| **Shading Model** | **PBR** (lit) or **Unlit**. Surface and Landscape only. |
| **Blend Mode** | **Opaque**, **Masked**, **Translucent** or **Additive**. Particle emitters set their own blending. |
| **Alpha Cutoff** | Masked only. Pixels with lower opacity are cut out. |
| **Two Sided** | Draws back faces too. |
| **Default Normals** | **Model Normals** or **Flat Normals** when the Normal input is unconnected. Flat Normals shade each triangle as a flat face. |
| **Bounds Padding (Local)** | Enlarges culling bounds for Materials that move vertices, so displaced meshes do not vanish at screen edges. |

In CEL projects, lit Surface Materials switch to CEL lighting automatically. Unlit and post-process Materials keep their own shading.

## Parameters

Parameters are the values you can change per instance or from scripts.

1. Add a [Float Parameter](../scripting/material/float-parameter.md), [Color Parameter](../scripting/material/color-parameter.md) or [Texture Parameter](../scripting/material/texture-parameter.md).
2. Enter a name in **Name Material Parameter**. Names are case-sensitive and must be unique in the graph.
3. Set the default value in the Inspector.

For a fixed texture, a [Texture Sample](../scripting/material/texture-sample.md) node can also pick its Texture directly. An unconnected UV uses the mesh's UVs, or screen UVs in a post-process Material.

## Material Instances

1. Create a **Material Instance** and set **Parent** to a Material or another Material Instance.
2. Each parent parameter appears with its inherited value. Edit a row to override it; reset it to inherit again.
3. **Remove Unused** clears overrides the parent no longer has.

Instances never recompile the shader, so they are cheap to create and switch. Every Material picker also lists instances of the matching domain.

## Material Functions

A Material Function is a reusable subgraph. Define its pins with [Function Inputs](../scripting/material/function-inputs.md) and [Function Outputs](../scripting/material/function-outputs.md), then call it from a Material with a [Material Function](../scripting/material/material-function.md) node. Renaming a pin does not break callers. Parameters inside a function are internal; to change a value from outside, expose it as a function input.

## Custom GLSL

The [Custom GLSL](../scripting/material/custom-glsl.md) node runs your own GLSL function body. Define typed inputs and outputs in the Inspector, return the first output and assign any extra outputs by name. Texture inputs arrive as samplers you can read with `texture2D`.

::: warning
Custom GLSL does not run on the WebGPU backend. Projects that use it should keep **GPU Backend** on WebGL2.
:::

Use **Render** after editing Custom GLSL. If compilation fails, the last working Material stays in use and the error appears in Compiler Results.

To turn existing fragment GLSL into an editable node graph, enable the Experimental **GLSL to Material** extension. See [Extensions](../projects/extensions.md).

## Change Materials from scripts

Read a Mesh component's **Material Object** variable, then use:

- [Set Material Float Parameter](../scripting/class/set-material-float-parameter.md), [Set Material Color Parameter](../scripting/class/set-material-color-parameter.md) and [Set Material Texture Parameter](../scripting/class/set-material-texture-parameter.md) to change a named parameter.
- The matching Get and Reset nodes, such as [Reset Material Float Parameter](../scripting/class/reset-material-float-parameter.md), to read a value or return to the default.
- [Set Material Instance](../scripting/class/set-material-instance.md) to swap a mesh to another instance. The old Material stays until the new one is ready.

Parameter changes affect only that mesh component. Other meshes using the same Material, and the asset itself, are unchanged.

## Related pages

- [Post-Processing](post-processing.md#scene-passes) for post-process Materials.
- [Particles](particles.md#look) for particle Materials.
- [Landscape and Foliage](../scenes/landscape.md) for Landscape Materials.
- [Models](models.md#materials) for model material slots.
