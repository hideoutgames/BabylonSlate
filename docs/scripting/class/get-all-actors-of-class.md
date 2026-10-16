# Get All Actors Of Class

Returns every actor in the game that is an instance of a Class.

## Inputs

| Pin | Type |
| --- | --- |
| Class | Actor Class |

## Outputs

| Pin | Type |
| --- | --- |
| Out | Array of Actor Reference |

## Notes

- Actors of Classes that inherit from the chosen Class are included.
- Returns an empty array when the Class is empty or no actor matches.
