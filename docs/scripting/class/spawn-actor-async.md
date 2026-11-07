---
node: actor.spawn
---

# Spawn Actor (Async)

Creates a new actor from a Class and returns a reference to it, while the game keeps running.

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

- Latent: execution waits while the Class and its resources load, then continues. The rest of the game keeps running meanwhile.
- To pause the game until the actor exists instead, use [**Spawn Actor (Blocking)**](spawn-actor-blocking.md).
- Returns an empty reference if the actor cannot be created, for example when **Class ID** is empty.
