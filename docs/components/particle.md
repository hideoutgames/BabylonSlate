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

## Scripting

Call the component's own functions on a reference to it: in a Class, its entry under **Components**; in a Scene Script, its **Get** node under **Scene Actors**; on any other actor, [Get Component](../scripting/class/get-component.md).

| Function | What it does |
| --- | --- |
| Play | Starts the Particle System. **Retrigger** decides what happens to a run still on screen. |
| Restart | Cuts the particles on screen and plays from the start, whatever **Retrigger** says. |
| Stop | Stops emitting. Live particles finish their lifetime. |
| Is Playing | Whether the component is playing. |
| Emit Burst | Emits **Count** extra particles from every emitter, or only the one at **Slot**. Does nothing unless the component is playing. |
| Set Float Parameter, Set Vector2 Parameter, Set Vector3 Parameter, Set Color Parameter | Sets a [parameter](../graphics/particles.md#parameters) of the System by **Name** while it plays, without restarting. Not saved. |
| Get Float Parameter, Get Vector2 Parameter, Get Vector3 Parameter, Get Color Parameter | The value set while playing, else the component's override, else the System's default. **Found** is false when the System does not declare **Name**. |
| Reset Parameter | Drops the value set while playing, back to the override or the default. |

- In a Class graph, the **Name** pin lists the parameters of the type the function takes, from the Systems of the Class's Particle components.
- A Float value fills every component of a Vector or Color parameter; a Vector2 parameter takes X and Y.
- A name the System does not declare is ignored, with one warning per name.
- [Event On Particles Finished](../scripting/class/event-on-particles-finished.md) runs when the component stops playing: a Particle System that does not loop ran out, or **Stop** was called, and the last particles are gone.

## Notes

- Works in world scenes and in Scene Layers.
- The actor's transform is where the particles are emitted from.
- Sorting Layers are listed back to front in **Project Settings > Game > Sorting Layers**. Particles still draw after opaque meshes and before blended ones, whatever their layer.
- For one-off effects that need no actor of their own, use [Spawn Particles At Location](../scripting/class/spawn-particles-at-location.md) or [Spawn Particles Attached](../scripting/class/spawn-particles-attached.md).

## Related

- [Particles](../graphics/particles.md)
- [Particle System](../assets/particle-system.md)
