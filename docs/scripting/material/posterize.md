---
node: color.posterize
---

# Posterize

Rounds Value down to a fixed number of even steps, for banded shading.

## Inputs

| Pin | Type | Default |
| --- | --- | --- |
| Value | Any | 0 |
| Steps | Float | 4 |

## Outputs

| Pin | Type |
| --- | --- |
| Out | Any |

## Notes

- Returns Value rounded down to a multiple of 1 / Steps.
- Each channel is rounded separately.
- Steps must not be 0.
