---
node: actor.destroy
---

# Destroy Actor

Removes an actor, and all of its components, from the game.

## Inputs

| Pin | Type |
| --- | --- |
| In | Exec |
| Target | Actor Reference |

## Outputs

| Pin | Type |
| --- | --- |
| Out | Exec |

## Notes

- The actor is removed after the current update step finishes, not in the middle of it.
- If **Target** is an empty reference, the actor running the graph is destroyed instead.
