---
node: transform.componentForward
---

# Get Component Forward Vector

Returns the component's forward direction in the world, of length 1.

## Inputs

| Pin | Type |
| --- | --- |
| Target | Component Reference |

## Outputs

| Pin | Type |
| --- | --- |
| Out | Vector 3 |

## Notes

- The direction follows the component's world rotation, including its actor's.
- See [Get Actor Forward Vector](get-actor-forward-vector.md) for an actor.
- If **Target** is empty, the node returns the default value and logs an error.
