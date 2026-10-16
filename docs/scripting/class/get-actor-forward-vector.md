---
node: transform.forward
---

# Get Actor Forward Vector

Returns the direction an actor faces, as a unit vector along its forward axis.

## Inputs

| Pin | Type |
| --- | --- |
| Target | Actor Reference |

## Outputs

| Pin | Type |
| --- | --- |
| Out | Vector 3 |

## Notes

- Forward is the actor's +Z axis.
- It is worked out from the actor's own rotation value, so a parent's rotation is not included.
