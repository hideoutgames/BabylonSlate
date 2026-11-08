---
node: object.getClass
---

# Get Class

Returns the object's Class, or None for a missing object.

## Inputs

| Pin | Type |
| --- | --- |
| Object | Object Reference |

## Outputs

| Pin | Type |
| --- | --- |
| Class | Class |

## Notes

- Use the result with [Class Is Child Of](class-is-child-of.md), or compare it with **Equal**.
- Returns None for an empty or destroyed object.
