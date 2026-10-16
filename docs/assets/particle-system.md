# Particle System

Plays up to eight Basic Particle Emitters or Particle Graphs together. This is the asset a Particle component plays.

## Create

In the **Content Browser**, choose **New Asset > Rendering > Particle System**.

## Editor

Double-tap the asset to open it. The window has **Preview** and an **Inspector**.

- **Preview** plays all the emitters together. **Restart** and **Play** or **Pause** are at the top, with badges for where it runs and how many particles are alive. With no emitters it shows **No Emitters**.
- In the **Inspector**, tap **Add Emitter** and pick a [Basic Particle Emitter](particle-emitter.md) or [Particle Graph](particle-graph.md).

## Settings

| Setting | Description |
| --- | --- |
| Space | **World** (default): particles stay where they were emitted. **Local**: particles move with the actor. |
| Preview Skybox | Shows the default sky behind the preview. Editor only. |
| Emitters | Up to 8 emitters, in order. The same emitter can appear more than once. An emitter that was deleted shows **Missing Emitter**. |

## Related

- [Particles](../graphics/particles.md)
- [Particle component](../components/particle.md)
- [Play Particles](../scripting/class/play-particles.md)
