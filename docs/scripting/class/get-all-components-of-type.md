# Get All Components Of Type

Returns every component of a type across all actors in the game.

## Inputs

| Pin | Type |
| --- | --- |
| Class | ActorComponent Class |

## Outputs

| Pin | Type |
| --- | --- |
| Out | Array of ActorComponent Reference |

## Notes

- Components of types that inherit from the chosen type are included.
- Returns an empty array when no component matches.
