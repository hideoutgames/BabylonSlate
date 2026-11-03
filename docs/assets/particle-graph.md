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

Select **Emitter Output**, or nothing, and the **Inspector** lists the graph's parameters under **Parameters**. Tap **Add Parameter** to add one.

| Setting | Description |
| --- | --- |
| Name | The name gameplay sets it by. Unique in the graph, up to 64 characters. |
| Type | **Float**, **Vector 2**, **Vector 3** or **Color**. Changing it resizes the default and retypes the Parameter nodes that read it. |
| Default | The value used when nothing sets it. |

- In **Add Node**, each parameter has a **Parameter: Name** entry under **Parameters**. It places a [Parameter](../scripting/particle/parameter.md) node titled with the parameter's name. Selecting the node lets you switch it to another parameter.
- Deleting a parameter that nodes read asks first. Those nodes stay and show an error until you delete them or pick another parameter.
- **Preview Parameters** under the Preview sets values for the preview only.

## Related

- [Particles](../graphics/particles.md)
- [Particle System](particle-system.md)
