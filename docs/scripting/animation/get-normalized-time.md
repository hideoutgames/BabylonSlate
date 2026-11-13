---
node: anim.state.normalisedTime
---

# Get Normalized Time

Returns how far through its clip the current state is, from 0 to 1.

## Outputs

| Pin | Type |
| --- | --- |
| Value | Float |

## Notes

- In a looping state it wraps back to 0 and never reaches 1. Use [**Exit Time Reached**](exit-time-reached.md) to detect the end of a loop.
- Available in transition rule graphs, where it reads the state the transition leaves, and in a state's graph, where it reads that state.
