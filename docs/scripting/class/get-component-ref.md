---
node: component.getNamed
---

# Get Component Ref

Returns a component of an actor as a typed reference.

## Inputs

| Pin | Type |
| --- | --- |
| Actor | Actor Reference |

## Outputs

| Pin | Type |
| --- | --- |
| Out | ActorComponent Reference |

## Notes

- The component type is stored on the node, so the output is typed as that component.
- When the node targets the owning actor, the **Actor** pin is hidden.
- Returns an empty reference if the actor has no component of that type.
