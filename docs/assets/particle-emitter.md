# Basic Particle Emitter

A particle emitter built from a stack of modules for spawning, shape, motion and colour, with no scripting.

## Create

In the **Content Browser**, choose **New Asset > Rendering > Basic Particle Emitter**. An emitter has no texture of its own: its look comes from a [Material](material.md) with the **Particle** domain, picked in the **Emitter** module.

## Editor

Double-tap the asset to open it. The window has **Preview** and an **Inspector**.

- **Preview** plays the emitter. **Restart** and **Play** or **Pause** are at the top, with badges for where it runs (**GPU** or **CPU**) and how many particles are alive. With no Material it shows **No Material** and **Pick Material**.
- The **Inspector** lists the modules in stages. Modules with a switch keep their values while off.

| Stage | Modules |
| --- | --- |
| Emitter | **Emitter**: Material, Capacity, Loop, Duration, Pre Warm |
| Spawn | **Spawn Rate**, **Bursts** |
| Shape | **Shape** |
| Initialize | **Initialize Particle**, **Scale**, **Rotation** |
| Over Life | **Speed Over Life**, **Speed Limit**, **Drag** |
| Forces | **Gravity** |
| Render | **Render**: Blend Mode and Billboard |

## Settings

The **Emitter** module:

| Setting | Description |
| --- | --- |
| Material | The particle Material that draws the particles. |
| Capacity | The most particles alive at once, from 16 to 4096. Default 256. |
| Loop | **Infinite** or **Once**. |
| Duration | One loop for Infinite, or how long a Once emitter spawns, in seconds. |
| Pre Warm | Starts an Infinite emitter as if it had already run for this many seconds. |

The **Render** module sets **Blend Mode** (default **Additive**) and **Billboard** (default **Camera Facing**). The other modules are described in [Particles](../graphics/particles.md#basic-particle-emitter).

## Related

- [Particles](../graphics/particles.md)
- [Particle System](particle-system.md)
- [Particle Graph](particle-graph.md)
- [Particle component](../components/particle.md)
