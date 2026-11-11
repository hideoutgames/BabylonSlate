---
node: transform.componentRight
---

# Get Component Right Vector

Returns the component's right direction in the world, of length 1.

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
- See [Get Actor Right Vector](get-actor-right-vector.md) for an actor.
- If **Target** is empty, the node returns the default value and logs an error.
