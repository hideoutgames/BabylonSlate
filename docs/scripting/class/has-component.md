---
node: component.has
---

# Has Component

Returns true when an actor has a component of a given type.

## Inputs

| Pin | Type |
| --- | --- |
| Actor | Actor Reference |
| Class ID | ActorComponent Class |

## Outputs

| Pin | Type |
| --- | --- |
| Out | Boolean |

## Notes

- Only components of exactly that type count; components of a derived type do not.
