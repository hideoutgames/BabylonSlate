---
node: array.swap
---

# Swap Array Items

Returns a copy of an array with two items swapped.

## Inputs

| Pin | Type | Description |
| --- | --- | --- |
| In | Exec |  |
| Array | Array of Wildcard |  |
| First Index | Integer |  |
| Second Index | Integer | Defaults to 1. |

## Outputs

| Pin | Type | Description |
| --- | --- | --- |
| Out | Exec |  |
| Out | Array of Wildcard |  |
| Success | Boolean | True when the items were swapped. |

## Notes

- When either index is outside the array, nothing is swapped: **Out** is the array unchanged and **Success** is false.
