---
node: wildcard.to_string
---

# Wildcard To String

Converts any value to text and never fails.

## Inputs

| Pin | Type | Description |
| --- | --- | --- |
| In | Any | The value to convert. Accepts any type. |

## Outputs

| Pin | Type |
| --- | --- |
| Out | String |

## Notes

- Numbers and booleans become their plain text, and an empty reference becomes null.
- Values with several parts, such as vectors, are written as a list like {x: 1, y: 2}.
