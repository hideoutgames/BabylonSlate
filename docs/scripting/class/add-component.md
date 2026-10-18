---
node: component.add
---

# Add Component

Adds a new component of a chosen type to an actor and returns it.

## Inputs

| Pin | Type | Description |
| --- | --- | --- |
| In | Exec |  |
| Actor | Actor Reference | The actor that receives the component. Left unconnected, it is the actor running the graph. |
| Class ID | ActorComponent Class |  |
| Transform | Transform | Starting transform of the new component. When not connected, it has no offset, no rotation and a scale of 1. |

## Outputs

| Pin | Type |
| --- | --- |
| Out | Exec |
| Out | ActorComponent Reference |

## Notes

- Returns an empty reference when nothing is added, for example when **Class ID** is empty or the component type does not suit the actor.
- If **Actor** is connected to a reference that is empty when the node runs, nothing is added and the result is empty.
