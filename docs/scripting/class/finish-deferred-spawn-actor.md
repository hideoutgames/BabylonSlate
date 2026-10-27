---
node: actor.finishDeferredSpawn
---

# Finish Deferred Spawn Actor

Puts an actor created by **Deferred Spawn Actor** into the game, running its **Event Begin Play**.

## Inputs

| Pin | Type | Description |
| --- | --- | --- |
| In | Exec |  |
| Actor | Actor Reference | The result of [**Deferred Spawn Actor**](deferred-spawn-actor.md). |

## Outputs

| Pin | Type |
| --- | --- |
| Out | Exec |
| Out | Actor Reference |

## Notes

- The actor appears with the variables, transform and components you set after **Deferred Spawn Actor**, and its **Event Begin Play** runs before execution continues.
- **Out** is the same actor, or an empty reference when it could not spawn: it was destroyed meanwhile, the streamed scene it belonged to was unloaded, or Play stopped.
- Finish each actor once. Passing an actor that is already in the game logs an error.
- If **Actor** is empty when the node runs, nothing happens and an error is logged.
