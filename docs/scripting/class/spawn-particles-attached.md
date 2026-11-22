---
node: particles.spawnAttached
---

# Spawn Particles Attached

Plays a Particle System attached to an actor, or one of its bones, without an actor class of its own.

## Inputs

| Pin | Type | Description |
| --- | --- | --- |
| In | Exec |  |
| System | Particle System | The Particle System to play. |
| Attach To | Actor Reference | The actor the effect follows. |
| Bone | String | A bone or [socket](../../assets/skeleton.md#sockets) of that actor's model to follow, typed or picked with the list button. Leave it empty to follow the actor. |
| Location Offset | Vector | The effect's position relative to the actor or bone. |
| Rotation Offset | Rotator | The effect's rotation relative to the actor or bone. |
| Auto Destroy | Boolean | Removes the effect when it finishes or is stopped. Default on. |

## Outputs

| Pin | Type | Description |
| --- | --- | --- |
| Out | Exec |  |
| Effect | Actor Reference | The effect, ready at once. Empty when nothing was spawned. |

## Notes

- **Effect** carries one [Particle](../../components/particle.md) component. Use [Get Component](get-component.md) on it to call **Stop**, **Emit Burst** or the parameter functions.
- If **Attach To** is destroyed, the effect stops emitting, stays where it was, lets its particles finish and is removed. Actors you attach yourself keep following their parent instead.
- A **System** that has not loaded yet (a Soft reference) loads first: **Effect** is returned at once and starts playing once the system has loaded. A warning names it the first time; if it fails to load, the effect is removed and an error is logged. See [Soft and Hard assets](../variables.md#soft-and-hard-assets).
- Nothing is spawned when **Attach To** is empty.
- It shares the limit of 256 spawned effects with [Spawn Particles At Location](spawn-particles-at-location.md).
