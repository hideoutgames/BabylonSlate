---
node: actor.getDistanceTo
---

# Get Distance To

Returns the distance between the two actors' world locations, or 0 when either is missing.

## Inputs

| Pin | Type |
| --- | --- |
| Target | Actor Reference |
| Other Actor | Actor Reference |

## Outputs

| Pin | Type |
| --- | --- |
| Distance | Float |

## Notes

- Leave **Target** unconnected to use the actor running the graph; the pin shows **Self**.
- Measures between world locations, so attached actors count where they really are.
- Returns 0 when either actor is missing.
