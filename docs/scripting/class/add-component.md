---
node: component.add
---

# Add Component

Adds a new component of a chosen type to an actor and returns it.

## Inputs

| Pin | Type | Description |
| --- | --- | --- |
| In | Exec |  |
| Actor | Actor Reference |  |
| Class ID | ActorComponent Class |  |
| Transform | Transform | Starting transform of the new component. When not connected, it has no offset, no rotation and a scale of 1. |

## Outputs

| Pin | Type |
| --- | --- |
| Out | Exec |
| Out | ActorComponent Reference |

## Notes

- Returns an empty reference when nothing is added, for example when **Class ID** is empty or the component type does not suit the actor.
