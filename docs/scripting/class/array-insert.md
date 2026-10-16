# Array Insert

Returns a copy of an array with an item inserted at an index.

## Inputs

| Pin | Type |
| --- | --- |
| In | Exec |
| Array | Array of Wildcard |
| Index | Integer |
| Item | Wildcard |

## Outputs

| Pin | Type |
| --- | --- |
| Out | Exec |
| Out | Array of Wildcard |

## Notes

- Items from **Index** onward move one place later.
- An **Index** below 0 inserts at the start, and one at or past the end adds the item to the end.
- The input array is not changed; assign **Out** to a variable to keep the result.
