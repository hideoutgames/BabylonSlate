---
node: anim.state.elapsedSeconds
---

# Elapsed Seconds

Returns how many seconds the current state's clip has played.

## Outputs

| Pin | Type |
| --- | --- |
| Value | Float |

## Notes

- For a looping state it restarts from 0 each time the clip wraps.
- Only available in transition rule graphs, where it reads the state the transition leaves.
