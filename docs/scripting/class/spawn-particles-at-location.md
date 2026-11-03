---
node: particles.spawnAtLocation
---

# Spawn Particles At Location

Plays a Particle System once at a place in the world, without an actor class of its own.

## Inputs

| Pin | Type | Description |
| --- | --- | --- |
| In | Exec |  |
| System | Particle System | The Particle System to play. |
| Location | Vector | Where the effect plays, in world space. |
| Rotation | Rotator | The effect's rotation. |
| Scale | Vector | The effect's scale. Default (1, 1, 1). |
| Auto Destroy | Boolean | Removes the effect when it finishes or is stopped. Default on. |

## Outputs

| Pin | Type | Description |
| --- | --- | --- |
| Out | Exec |  |
| Effect | Actor Reference | The effect, ready at once: you can stop it, burst it or move it in the same frame. Empty when nothing was spawned. |

## Notes

- **Effect** carries one [Particle](../../components/particle.md) component. Use [Get Component](get-component.md) on it to call **Stop**, **Emit Burst** or the parameter functions.
- A looping Particle System with **Auto Destroy** plays until its Particle component's **Stop** is called; it then finishes its particles and is removed.
- Up to 256 spawned effects play at once. Beyond that the oldest one stops and is removed, and a warning is logged once.
- If **System** is not a Particle System, nothing is spawned, **Effect** is empty and a warning is logged.
