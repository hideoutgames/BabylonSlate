---
node: component.getNamed
---

# Get Component Ref

Returns a component of an actor as a typed reference.

## Inputs

| Pin | Type | Description |
| --- | --- | --- |
| Target | Actor Reference | The actor that owns the component. When the node targets the owning actor the pin reads **Target (Self)**; connect another actor to read its component instead. |

## Outputs

| Pin | Type |
| --- | --- |
| Out | ActorComponent Reference |

## Notes

- The component type is stored on the node, so the output is typed as that component.
- Returns an empty reference if the actor has no component of that type, or if **Target** is connected to a reference that is empty, which also logs an error.
