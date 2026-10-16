# Array Slice

Returns a new array holding the items from a start index up to an end index.

## Inputs

| Pin | Type | Description |
| --- | --- | --- |
| Array | Array of Wildcard |  |
| Start | Integer | Index of the first item to copy, counting from 0. |
| End | Integer | Index after the last item to copy. |

## Outputs

| Pin | Type |
| --- | --- |
| Out | Array of Wildcard |

## Notes

- The item at **End** is not included, so an **End** of 0 gives an empty array.
- Negative values count back from the end of the array.
