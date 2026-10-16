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

## Related

- [Particles](../graphics/particles.md)
- [Particle System](particle-system.md)
