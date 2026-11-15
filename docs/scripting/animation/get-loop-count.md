---
node: anim.state.loopCount
---

# Get Loop Count

Returns how many times the current clip has looped since the state started.

## Outputs

| Pin | Type |
| --- | --- |
| Value | Integer |

## Notes

- Always 0 for a state that does not loop.
- Available in transition rule graphs, where it reads the state the transition leaves, and in a state's graph, where it reads that state.
