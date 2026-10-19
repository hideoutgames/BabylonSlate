---
node: transform.getLocation
---

# Get Actor Location

Returns an actor's location as a vector.

## Inputs

| Pin | Type |
| --- | --- |
| Target | Actor Reference |

## Outputs

| Pin | Type |
| --- | --- |
| Out | Vector 3 |

## Notes

- For an attached actor, the location is relative to its parent.
- Returns zero, and logs an error, when the reference is empty.
