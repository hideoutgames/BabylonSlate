---
node: transform.get
---

# Get Actor Transform

Returns an actor's location, rotation and scale as one transform.

## Inputs

| Pin | Type |
| --- | --- |
| Target | Actor Reference |

## Outputs

| Pin | Type |
| --- | --- |
| Out | Transform |

## Notes

- For an attached actor, the values are relative to its parent.
- Use [**Break Transform**](break-transform.md) to split the result into its parts.
