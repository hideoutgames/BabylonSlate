---
node: flow.event.sceneActorSpawned
---

# Event On Scene Actor Spawned

Runs on a Scene Subsystem when an actor in the scene is about to begin play.

## Outputs

| Pin | Type | Description |
| --- | --- | --- |
| Out | Exec |  |
| Actor | Actor Reference | The actor that is entering play. |

## Notes

- Runs immediately before the actor's [**Event Begin Play**](event-begin-play.md), for placed and spawned actors in the main scene or a streamed sub-scene.
- Actors on Scene Layers are not reported. Only in Scene Subsystem classes.
