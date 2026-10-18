---
node: actor.destroy
---

# Destroy Actor

Removes an actor, and all of its components, from the game.

## Inputs

| Pin | Type | Description |
| --- | --- | --- |
| In | Exec |  |
| Target | Actor Reference | The actor to remove. Left unconnected, it removes the actor running the graph. |

## Outputs

| Pin | Type |
| --- | --- |
| Out | Exec |

## Notes

- The actor is removed after the current update step finishes, not in the middle of it.
- If **Target** is connected to a reference that is empty when the node runs, nothing happens. Only an unconnected **Target** means the actor running the graph.
