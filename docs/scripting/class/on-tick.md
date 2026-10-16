---
node: bt.event.tick
---

# On Tick

Runs every update while a task is active, or at each interval for a service.

## Outputs

| Pin | Type |
| --- | --- |
| Out | Exec |

## Notes

- In a BTTask class it runs every update until the task finishes. In a BTService class it runs at the service's interval while the node it is attached to is active.
- Not available in BTDecorator classes.
