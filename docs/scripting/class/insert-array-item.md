---
node: array.insert
---

# Insert Array Item

Returns a copy of an array with an item inserted at an index.

## Inputs

| Pin | Type |
| --- | --- |
| In | Exec |
| Array | Array of Wildcard |
| Index | Integer |
| Item | Wildcard |

## Outputs

| Pin | Type | Description |
| --- | --- | --- |
| Out | Exec |  |
| Out | Array of Wildcard |  |
| Success | Boolean | True when the item was inserted. |

## Notes

- Items from **Index** onward move one place later.
- An **Index** equal to the array's length adds the item to the end. Any other **Index** outside the array inserts nothing: **Out** is the array unchanged and **Success** is false.
- The input array is not changed; assign **Out** to a variable to keep the result.
