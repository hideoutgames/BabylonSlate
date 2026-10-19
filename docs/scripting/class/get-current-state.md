---
node: anim.actor.getCurrentState
---

# Get Current State

Returns the name and ID of the state an Animation Graph is in.

## Inputs

| Pin | Type | Description |
| --- | --- | --- |
| Target | AnimationGraphComponent Reference | The Animation Graph component to read. |

## Outputs

| Pin | Type | Description |
| --- | --- | --- |
| Name | String |  |
| ID | String | Unique identifier of the state. |

## Notes

- Before the graph's first update it returns the entry state. With an invalid target, the outputs are empty; an empty target also logs an error.
- Only available in Actor class graphs.
