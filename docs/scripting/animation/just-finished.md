---
node: anim.state.justFinished
---

# Just Finished

Returns true only in the update where a non-looping clip reaches its end.

## Outputs

| Pin | Type |
| --- | --- |
| Value | Boolean |

## Notes

- Always false for a looping state.
- Only available in transition rule graphs, where it reads the state the transition leaves.
