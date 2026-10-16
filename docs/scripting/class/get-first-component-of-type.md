---
node: component.getFirstOfType
---

# Get First Component Of Type

Returns the first component of a type found on any actor in the game.

## Inputs

| Pin | Type |
| --- | --- |
| Class | ActorComponent Class |

## Outputs

| Pin | Type |
| --- | --- |
| Out | ActorComponent Reference |

## Notes

- Components of types that inherit from the chosen type are included.
- Returns an empty reference when no component matches.
