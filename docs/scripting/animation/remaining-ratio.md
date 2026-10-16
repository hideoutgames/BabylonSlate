---
node: anim.state.remainingRatio
---

# Remaining Ratio

Returns the fraction of the current clip still to play, from 1 down to 0.

## Outputs

| Pin | Type |
| --- | --- |
| Value | Float |

## Notes

- It equals 1 minus [**Normalised Time**](normalised-time.md).
- Only available in transition rule graphs, where it reads the state the transition leaves.
