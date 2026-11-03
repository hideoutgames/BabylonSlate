# Particle Graph

A particle emitter built as a node graph, for custom per-particle behaviour. It always runs on the CPU.

## Create

In the **Content Browser**, choose **New Asset > Rendering > Particle Graph**. Like a [Basic Particle Emitter](particle-emitter.md), its look comes from a [Material](material.md) with the **Particle** domain.

## Editor

Double-tap the asset to open it. The window has **Graph**, **Preview**, **Inspector** and **Compiler Results**.

- In **Graph**, wire a chain that starts at [Create Particle](../scripting/particle/create-particle.md), passes through shape and update nodes, and ends at [Emitter Output](../scripting/particle/emitter-output.md). See the [particle node reference](../scripting/particle/index.md).
- **Preview** plays the emitter. While the graph has errors it shows **Graph Has Errors** and keeps the last valid result.
- **Compiler Results** lists errors to fix.
- Select **Emitter Output**, or nothing, to edit the emitter settings in the **Inspector**.

## Settings

| Setting | Description |
| --- | --- |
| Material | The particle Material that draws the particles. |
| Capacity | The most particles alive at once, from 16 to 4096. Above 512 costs more on iPad. |
| Loop | **Infinite** or **Once**. |
| Duration | One loop for Infinite, or how long a Once emitter spawns, in seconds. |
| Pre Warm | Infinite only. Starts the emitter as if it had already run for this many seconds. |
| Blend Mode | How particles blend with the scene. |
| Billboard | How particles face the camera. |

**Emit Rate** is set on the Emitter Output node.

## Parameters

A parameter is a value gameplay can set while the emitter runs. Each one is read by [Parameter](../scripting/particle/parameter.md) nodes, titled with the parameter's name.

- **Add Node** lists them under **Parameter**: **Float Parameter**, **Vector 2 Parameter**, **Vector 3 Parameter** and **Color Parameter** add a new parameter, and each existing parameter has an entry by its name that adds another node reading it.
- Right-click a [Float](../scripting/particle/float.md), [Vector 2](../scripting/particle/vector-2.md), [Vector 3](../scripting/particle/vector-3.md) or [Color](../scripting/particle/color.md) node, or long-press it, and choose **Convert to Parameter**. The node becomes a Parameter node of a new parameter whose default is the constant's value. Its wires stay.
- On a Parameter node, **Convert to Constant** does the reverse: the node becomes a constant holding the parameter's default.

Select a Parameter node to edit its parameter in the **Inspector**. Every node that reads the parameter shares these settings.

| Setting | Description |
| --- | --- |
| Parameter | The parameter the node reads. Pick another to switch it. |
| Name | The name gameplay sets it by. Unique in the graph, up to 64 characters. |
| Type | **Float**, **Vector 2**, **Vector 3** or **Color**. Changing it resizes the default and retypes every node that reads it. |
| Default | The value used when nothing sets it. |

- A parameter is removed when its last node is deleted, converted or switched to another parameter. Undo brings it back.
- Pasting a Parameter node into a graph without its parameter adds the parameter again, or reads the graph's parameter of the same name and type.
- **Preview Parameters** under the Preview sets values for the preview only.

## Related

- [Particles](../graphics/particles.md)
- [Particle System](particle-system.md)
