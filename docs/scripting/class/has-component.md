---
node: component.has
---

# Has Component

Returns true when an actor has a component of a given type.

## Inputs

| Pin | Type | Description |
| --- | --- | --- |
| Actor | Actor Reference | The actor to check. Left unconnected the pin shows **Self** and checks the actor running the graph. |
| Class ID | ActorComponent Class |  |

## Outputs

| Pin | Type |
| --- | --- |
| Out | Boolean |

## Notes

- A component of a derived type counts too, as in [**Get Component**](get-component.md).
- Returns false, and logs an error, when **Actor** is connected to a reference that is empty.
