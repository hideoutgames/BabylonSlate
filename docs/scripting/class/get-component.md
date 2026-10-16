---
node: component.get
---

# Get Component

Returns the component of a given type on one actor.

## Inputs

| Pin | Type |
| --- | --- |
| Actor | Actor Reference |
| Class ID | ActorComponent Class |

## Outputs

| Pin | Type |
| --- | --- |
| Out | ActorComponent Reference |

## Notes

- Only components of exactly that type match; components of a derived type do not.
- If the actor has several, the first is returned. Returns an empty reference when it has none.
