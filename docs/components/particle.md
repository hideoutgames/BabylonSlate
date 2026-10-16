# Particle

Plays a Particle System from an actor.

## Add it

Select an actor, then choose **Add Component > Particles > Particle**. You can also place a ready-made actor from **Place Actors > Particles > Particle**.

## Settings

| Setting | Description |
| --- | --- |
| Particle System | The [Particle System](../assets/particle-system.md) to play. |
| Play On Start | Starts the effect when Play begins. Default on. |
| Sorting Layer | The layer the particles draw on. Default **Default**. |
| Order In Layer | Order within the layer. Default 0. |

## Notes

- Works in world scenes and in Scene Layers.
- The actor's transform is where the particles are emitted from.
- Sorting Layers are listed back to front in **Project Settings > Game > Sorting Layers**. Particles still draw after opaque meshes and before blended ones, whatever their layer.
- [Play Particles](../scripting/class/play-particles.md) and [Stop Particles](../scripting/class/stop-particles.md) start and stop every particle component on an actor. The component also has **Play** and **Stop** functions.

## Related

- [Particles](../graphics/particles.md)
- [Particle System](../assets/particle-system.md)
