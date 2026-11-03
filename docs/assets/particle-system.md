# Particle System

Plays up to eight Basic Particle Emitters or Particle Graphs together. This is the asset a Particle component plays.

## Create

In the **Content Browser**, choose **New Asset > Rendering > Particle System**.

Or select up to eight Basic Particle Emitters and Particle Graphs, right-click one and choose **Create Particle System**. See [Create from assets](../editor/content-browser.md#create-from-assets).

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
| Parameters | The emitters' parameters, joined by name. Each starts at the default of the first emitter that declares it; edit it to give the System its own default, or reset it to go back. Shown only when an emitter has parameters. |

If two emitters declare one parameter name with different types, the later emitter keeps its own default and **Parameters** says which slot. **Preview Parameters** under the Preview sets values for the preview only.

## Related

- [Particles](../graphics/particles.md)
- [Particle component](../components/particle.md)
- [Play Particles](../scripting/class/play-particles.md)
