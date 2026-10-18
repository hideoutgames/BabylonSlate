---
node: component.has
---

# Has Component

Returns true when an actor has a component of a given type.

## Inputs

| Pin | Type | Description |
| --- | --- | --- |
| Actor | Actor Reference | The actor to check. Left unconnected, it checks the actor running the graph. |
| Class ID | ActorComponent Class |  |

## Outputs

| Pin | Type |
| --- | --- |
| Out | Boolean |

## Notes

- Only components of exactly that type count; components of a derived type do not.
- Returns false when **Actor** is connected to a reference that is empty.
