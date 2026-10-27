---
node: actor.deferredSpawn
---

# Deferred Spawn Actor

Creates a new actor from a Class without starting it, so you can set it up before its **Event Begin Play** runs.

## Inputs

| Pin | Type | Description |
| --- | --- | --- |
| In | Exec |  |
| Class ID | Actor Class |  |
| Transform | Transform | Where the new actor appears. When not connected, it appears at the origin with no rotation and a scale of 1. |

## Outputs

| Pin | Type |
| --- | --- |
| Out | Exec |
| Out | Actor Reference |

## Notes

- The actor is not in the game yet: it is not drawn, does not tick, collide or appear in **Get All Actors Of Class**, and its Class's events and functions do not run.
- Before it starts, you can set its variables, its location, rotation and scale, and the properties of its components, and add components to it. Use [**Cast To**](cast-to.md) on **Out** to reach the variables of its Class.
- Connect **Out** to [**Finish Deferred Spawn Actor**](finish-deferred-spawn-actor.md) to put the actor in the game. Its **Event Begin Play** then sees everything you set.
- An actor that never finishes stays out of the game. [**Destroy Actor**](destroy-actor.md) on it cancels the spawn.
- Latent: execution waits while the Class and its resources load, then continues without pausing the rest of the game.
- Returns an empty reference if the actor cannot be created, for example when **Class ID** is empty.
