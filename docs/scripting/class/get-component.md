---
node: component.get
---

# Get Component

Returns the component of a given type on one actor.

## Inputs

| Pin | Type | Description |
| --- | --- | --- |
| Actor | Actor Reference | The actor to search. Left unconnected the pin shows **Self** and searches the actor running the graph. |
| Class ID | ActorComponent Class |  |

## Outputs

| Pin | Type |
| --- | --- |
| Out | ActorComponent Reference |

## Notes

- A component of a derived type matches too, as in [**Get First Component Of Type**](get-first-component-of-type.md).
- If the actor has several, the first is returned. Returns an empty reference when it has none, or when **Actor** is connected to a reference that is empty, which also logs an error.
