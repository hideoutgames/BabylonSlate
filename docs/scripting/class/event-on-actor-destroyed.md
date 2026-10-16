---
node: flow.event.destroyed
---

# Event On Actor Destroyed

Runs when the actor this graph belongs to is destroyed.

## Outputs

| Pin | Type |
| --- | --- |
| Out | Exec |

## Notes

- Use it for cleanup. The actor is already being removed when the event runs.
- On a component class the node is titled **Event Destroyed**.
