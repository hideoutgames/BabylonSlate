---
node: transform.componentUp
---

# Get Component Up Vector

Returns the component's up direction in the world, of length 1.

## Inputs

| Pin | Type |
| --- | --- |
| Target | Component Reference |

## Outputs

| Pin | Type |
| --- | --- |
| Out | Vector3 |

## Notes

- The direction follows the component's world rotation, including its actor's.
- See [Get Actor Up Vector](get-actor-up-vector.md) for an actor.
- If **Target** is empty, the node returns the default value and logs an error.
