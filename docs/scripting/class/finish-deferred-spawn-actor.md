---
node: actor.finishDeferredSpawn
---

# Finish Deferred Spawn Actor

Puts an actor created by **Spawn Actor Deferred (Async)** or **Spawn Actor Deferred (Blocking)** into the game, running its **Event Begin Play**.

## Inputs

| Pin | Type | Description |
| --- | --- | --- |
| In | Exec |  |
| Actor | Actor Reference | The result of [**Spawn Actor Deferred (Async)**](spawn-actor-deferred-async.md) or [**Spawn Actor Deferred (Blocking)**](spawn-actor-deferred-blocking.md). |

## Outputs

| Pin | Type |
| --- | --- |
| Out | Exec |
| Out | Actor Reference |

## Notes

- The actor appears with the variables, transform and components you set after the deferred spawn, and its **Event Begin Play** runs before execution continues.
- **Out** is the same actor, or an empty reference when it could not spawn: it was destroyed meanwhile, the streamed scene it belonged to was unloaded, or Play stopped.
- Finish each actor once. Passing an actor that is already in the game logs an error.
- If **Actor** is empty when the node runs, nothing happens and an error is logged.
