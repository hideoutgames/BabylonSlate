---
node: actor.destroy
---

# Destroy Actor

Removes an actor, and all of its components, from the game.

## Inputs

| Pin | Type | Description |
| --- | --- | --- |
| In | Exec |  |
| Target | Actor Reference | The actor to remove. Left unconnected the pin shows **Self** and removes the actor running the graph. |

## Outputs

| Pin | Type |
| --- | --- |
| Out | Exec |

## Notes

- The actor is removed after the current update step finishes, not in the middle of it.
- References to the actor that you stored keep pointing at it, but once it is removed [Is Valid](is-valid.md) returns false for them, and nodes given one do nothing and log an error. About once a second, stored references to it become empty.
- Destroying an actor that was already destroyed does nothing, even if a newer actor has since been given the same id.
- If **Target** is connected to a reference that is empty when the node runs, nothing happens and an error is logged. Only an unconnected **Target** means the actor running the graph.
