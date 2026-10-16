# Particles

Particle effects such as sparks, smoke and magic are built from emitters grouped into a Particle System, then played by a [Particle](../components/particle.md) component in the scene.

## The three assets

| Asset | What it is |
| --- | --- |
| [Basic Particle Emitter](../assets/particle-emitter.md) | An emitter built from a stack of modules. No scripting. Runs on the GPU when the device supports it. |
| [Particle Graph](../assets/particle-graph.md) | An emitter built as a node graph, for custom per-particle logic. Always runs on the CPU. |
| [Particle System](../assets/particle-system.md) | Up to 8 emitters of either kind, played together. This is what the Particle component plays. |

Create them in the **Content Browser** from the **Rendering** group of the New Asset dialog.

## Make an effect

1. Create a [Material](materials.md) and set its **Domain** to **Particle**. Wire [Particle Color](../scripting/material/particle-color.md) into [Particle Output](../scripting/material/particle-output.md), and sample a texture with [Texture Sample](../scripting/material/texture-sample.md) if you want one.
2. Create a **Basic Particle Emitter** and pick that Material in its **Emitter** module. The default settings make a small fountain.
3. Create a **Particle System** and add the emitter under **Emitters**.
4. Open **Place Actors > Particles > Particle** and pick the System in **Particle System**.

Particles play in Play and in the asset previews. In the scene viewport you see the particle icon only.

## Look

Emitters have no texture field: an emitter's look is its particle Material. An emitter without a Material does not render, and its preview shows **No Material** with **Pick Material**.

| Setting | Options |
| --- | --- |
| **Blend Mode** | **Additive** (default), **Normal**, **Alpha Additive**, **Multiply**, **Subtract** |
| **Billboard** | **Camera Facing** (default), **Y Axis**, **Stretched** (stretches along velocity; Scale Y sets the length) |

The emitter sets blending, so particle Materials have no Blend Mode of their own.

## Basic Particle Emitter

The **Inspector** shows the modules in stages. Modules with a switch keep their values while off.

| Stage | Modules |
| --- | --- |
| Emitter | **Emitter**: Material, Capacity (16 to 4096, default 256), Loop (Infinite or Once), Duration, Pre Warm |
| Spawn | **Spawn Rate**, **Bursts** (up to 8 entries with Time, Count, Cycles and Interval) |
| Shape | **Shape**: Point, Box, Sphere, Hemisphere, Cylinder or Cone, with Radial or Directed direction |
| Initialize | **Initialize Particle** (Lifetime, Speed, Size, Color), **Scale**, **Rotation** |
| Over Life | **Speed Over Life**, **Speed Limit**, **Drag** |
| Forces | **Gravity** (default 0, −9.81, 0 m/s²) |
| Render | **Render**: Blend Mode and Billboard |

Many values can be a **Constant**, a **Random Range** or a **Curve** (a **Gradient** for colour). Rate and Lifetime curves run over the emitter's loop; other curves run over each particle's life.

- Units are seconds, metres per second and degrees.
- **Pre Warm** starts an Infinite emitter as if it had already run for that many seconds. It is not available for Once.
- If the device cannot run the emitter on the GPU, it runs on the CPU with at most 512 particles.

## Particle Graph

A Particle Graph opens with **Graph**, **Preview**, **Inspector** and **Compiler Results**. The particle passes along a chain from [Create Particle](../scripting/particle/create-particle.md), through a shape such as [Sphere Shape](../scripting/particle/sphere-shape.md) and update nodes such as [Apply Velocity](../scripting/particle/apply-velocity.md) and [Update Color](../scripting/particle/update-color.md), to [Emitter Output](../scripting/particle/emitter-output.md).

- Inputs of Create Particle are read once when a particle is born. Inputs of update nodes are read every frame.
- Select **Emitter Output** (or nothing) to set Material, Capacity, Loop, Duration, Pre Warm, Blend Mode, Billboard and **Emit Rate**.
- Particle Graphs run on the CPU. Capacity can go up to 4096, but more than 512 particles costs more on iPad.
- While the graph has errors, Preview keeps showing the last valid version.
- [Attractor](../scripting/particle/attractor.md) and [Gravity](../scripting/particle/gravity.md) add forces. Particle Graph pages are listed in the [particle node reference](../scripting/particle/index.md).

## Particle System

| Setting | Description |
| --- | --- |
| **Space** | **World** (default): particles stay where they were emitted. **Local**: particles move with the actor. |
| **Preview Skybox** | Shows the default sky behind the System's preview. Editor only. |
| **Emitters** | Up to 8 emitters, in order. The same emitter can appear more than once. |

The Preview has **Restart** and **Play / Pause**, plus badges showing where it runs (**GPU**, **CPU** or both) and how many particles are alive.

## Play particles from scripts

The Particle component's **Play On Start** (on by default) starts the effect when the actor spawns. Otherwise use:

- [Play Particles](../scripting/class/play-particles.md) to start an actor's particles.
- [Stop Particles](../scripting/class/stop-particles.md) to stop emitting. Live particles finish their lifetime.

Particles freeze while Play is paused.
