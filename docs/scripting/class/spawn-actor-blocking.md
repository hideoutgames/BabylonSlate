---
node: actor.spawnBlocking
---

# Spawn Actor (Blocking)

Creates a new actor from a Class and returns a reference to it, pausing the game until it exists.

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

- Loads the Class and its resources at High priority and pauses game simulation (ticks, physics, timers and tweens) until the actor can be created, like [**Load Class Blocking**](load-class-blocking.md). Loading and rendering preparation continue, so no game time passes before the actor exists.
- To keep the game running while the Class loads, use [**Spawn Actor (Async)**](spawn-actor-async.md).
- Returns an empty reference if the actor cannot be created, for example when **Class ID** is empty.
- Latent: execution continues once the actor exists.
