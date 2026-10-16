# Set At Index

Returns a copy of an array with the item at an index replaced.

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
| Success | Boolean | True when **Index** was inside the array and the item was replaced. |

## Notes

- The input array is not changed; assign **Out** to a variable to keep the result.
- An **Index** outside the array leaves it unchanged and sets **Success** to false, so items are never added.
