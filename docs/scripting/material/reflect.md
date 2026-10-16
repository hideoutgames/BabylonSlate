---
node: vector.reflect
---

# Reflect

Reflects Incident around Normal and returns the bounced direction.

## Inputs

| Pin | Type | Default |
| --- | --- | --- |
| Incident | Any | 0 |
| Normal | Any | 0 |

## Outputs

| Pin | Type |
| --- | --- |
| Out | Any |

## Notes

- Normal should have a length of 1. Use [**Normalize**](normalize.md) first if it might not.
