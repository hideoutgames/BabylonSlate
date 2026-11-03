# Particle

Plays a Particle System from an actor.

## Add it

Select an actor, then choose **Add Component > Particles > Particle**. You can also place a ready-made actor from **Place Actors > Particles > Particle**.

## Settings

| Setting | Description |
| --- | --- |
| Particle System | The [Particle System](../assets/particle-system.md) to play. |
| Play On Start | Starts the effect when Play begins. Default on. |
| Retrigger | What **Play** does while the effect is still on screen. **Overlap** (default) lets the earlier run finish while a new run starts, keeping up to three earlier runs; a looping system that is playing keeps playing. **Restart** cuts the effect and starts again. |
| Sorting Layer | The layer the particles draw on. Default **Default**. |
| Order In Layer | Order within the layer. Default 0. |
| Parameters | One row per [parameter](../graphics/particles.md#parameters) of the Particle System, at the System's default. Edit a value to override it for this actor; clear its **Override** box to go back to the default. Shown only when the System has parameters. |

## Notes

- Works in world scenes and in Scene Layers.
- The actor's transform is where the particles are emitted from.
- Sorting Layers are listed back to front in **Project Settings > Game > Sorting Layers**. Particles still draw after opaque meshes and before blended ones, whatever their layer.
- [Play Particles](../scripting/class/play-particles.md) and [Stop Particles](../scripting/class/stop-particles.md) start and stop every particle component on an actor, [Is Particles Playing](../scripting/class/is-particles-playing.md) checks whether any of them plays, and [Emit Particle Burst](../scripting/class/emit-particle-burst.md) adds a burst to the ones that are playing. The component also has **Play**, **Restart**, **Stop**, **Is Playing** and **Emit Burst** functions. [Restart Particles](../scripting/class/restart-particles.md) always cuts and starts again, whatever **Retrigger** says.
- [Event On Particles Finished](../scripting/class/event-on-particles-finished.md) runs when the component stops playing: a Particle System that does not loop ran out, or **Stop** was called, and the last particles are gone.
- [Set Particle Float Parameter](../scripting/class/set-particle-float-parameter.md), [Set Particle Vector Parameter](../scripting/class/set-particle-vector-parameter.md) and [Set Particle Color Parameter](../scripting/class/set-particle-color-parameter.md) change the System's [parameters](../graphics/particles.md#parameters) while it plays; the Get and [Reset](../scripting/class/reset-particle-parameter.md) nodes read and undo them. The component also has **Set**, **Get** and **Reset Parameter** functions that act on that component only.

- For one-off effects that need no actor of their own, use [Spawn Particles At Location](../scripting/class/spawn-particles-at-location.md) or [Spawn Particles Attached](../scripting/class/spawn-particles-attached.md).

## Related

- [Particles](../graphics/particles.md)
- [Particle System](../assets/particle-system.md)
