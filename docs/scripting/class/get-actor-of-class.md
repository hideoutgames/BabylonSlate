---
node: actor.getOfClass
---

# Get Actor Of Class

Returns one actor of a Class, or an empty reference when none exists.

## Inputs

| Pin | Type |
| --- | --- |
| Class | Actor Class |

## Outputs

| Pin | Type |
| --- | --- |
| Out | Actor Reference |

## Notes

- Actors of Classes that inherit from the chosen Class are included.
- If several actors match, the first one found is returned. Use [**Get All Actors Of Class**](get-all-actors-of-class.md) to get them all.
