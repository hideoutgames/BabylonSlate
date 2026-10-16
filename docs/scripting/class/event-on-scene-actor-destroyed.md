---
node: flow.event.sceneActorDestroyed
---

# Event On Scene Actor Destroyed

Runs on a Scene Subsystem when an actor it saw spawn is destroyed.

## Outputs

| Pin | Type | Description |
| --- | --- | --- |
| Out | Exec |  |
| Actor | Actor Reference | The actor that is being destroyed. |

## Notes

- Runs after the actor is removed from the scene and before its own [**Event On Actor Destroyed**](event-on-actor-destroyed.md).
- Only in Scene Subsystem classes.
