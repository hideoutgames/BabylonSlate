# Remove Item

Returns a copy of an array with the first matching item removed.

## Inputs

| Pin | Type |
| --- | --- |
| In | Exec |
| Array | Array of Wildcard |
| Item | Wildcard |

## Outputs

| Pin | Type | Description |
| --- | --- | --- |
| Out | Exec |  |
| Out | Array of Wildcard |  |
| Success | Boolean | True when a matching item was found and removed. |

## Notes

- Only the first match is removed; when nothing matches, the array is unchanged and **Success** is false.
- The input array is not changed; assign **Out** to a variable to keep the result.
