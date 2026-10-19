---
node: transform.getScale
---

# Get Actor Scale

Returns an actor's scale on each axis as a vector.

## Inputs

| Pin | Type |
| --- | --- |
| Target | Actor Reference |

## Outputs

| Pin | Type |
| --- | --- |
| Out | Vector 3 |

## Notes

- A scale of 1 on every axis is the actor's original size.
- Returns 1 on every axis, and logs an error, when the reference is empty.
