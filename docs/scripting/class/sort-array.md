---
node: array.sort
---

# Sort Array

Returns a copy of an array in ascending or descending order.

## Inputs

| Pin | Type | Description |
| --- | --- | --- |
| Array | Array of Wildcard |  |
| Descending | Boolean | Off by default. |

## Outputs

| Pin | Type |
| --- | --- |
| Out | Array of Wildcard |

## Notes

- Numbers sort by value and text by character code, so capital letters come before lower-case ones.
- The input array is not changed. Assign **Out** to a variable to keep the result.
- A pure node: it has no execution pins and is evaluated when its result is read.
