---
node: actor.spawn
---

# Spawn Actor

Creates a new actor from a Class and returns a reference to it.

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

- Latent: execution waits while the Class and its resources load, then continues.
- Returns an empty reference if the actor cannot be created, for example when **Class ID** is empty.
- Latent: the node finishes later without pausing the rest of the game.
