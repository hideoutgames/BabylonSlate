# Remove At

Returns a copy of an array with the item at an index removed.

## Inputs

| Pin | Type |
| --- | --- |
| In | Exec |
| Array | Array of Wildcard |
| Index | Integer |

## Outputs

| Pin | Type | Description |
| --- | --- | --- |
| Out | Exec |  |
| Out | Array of Wildcard |  |
| Success | Boolean | True when **Index** was inside the array and an item was removed. |

## Notes

- An **Index** outside the array leaves it unchanged and sets **Success** to false.
- The input array is not changed. Assign **Out** to a variable to keep the result.
