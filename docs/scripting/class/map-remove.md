# Map Remove

Returns a copy of a map without the given key.

## Inputs

| Pin | Type |
| --- | --- |
| In | Exec |
| Map | Map of Wildcard to Wildcard |
| Key | Wildcard |

## Outputs

| Pin | Type | Description |
| --- | --- | --- |
| Out | Exec |  |
| Out | Map of Wildcard to Wildcard |  |
| Removed | Boolean | True when the key was in the map and has been removed. |

## Notes

- The input map is not changed. Assign **Out** to a variable to keep the result.
