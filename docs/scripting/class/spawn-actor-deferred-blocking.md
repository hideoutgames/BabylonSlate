---
node: actor.deferredSpawnBlocking
---

# Spawn Actor Deferred (Blocking)

Creates a new actor from a Class without starting it, so you can set it up before its **Event Begin Play** runs. The game pauses until the actor exists.

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
- Loads the Class and its resources at High priority and pauses game simulation (ticks, physics, timers and tweens) until the actor can be created, like [**Load Class (Blocking)**](load-class-blocking.md). Loading and rendering preparation continue, so no game time passes before the actor exists.
- To keep the game running while the Class loads, use [**Spawn Actor Deferred (Async)**](spawn-actor-deferred-async.md).
- Returns an empty reference if the actor cannot be created, for example when **Class ID** is empty.
- Latent: execution continues once the actor exists.
