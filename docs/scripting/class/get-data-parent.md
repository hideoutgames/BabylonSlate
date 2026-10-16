# Get Data Parent

Returns the path of an entry's parent.

## Inputs

| Pin | Type | Description |
| --- | --- | --- |
| Tree | DataTree Asset |  |
| Entry Path | String | The entry's exact, case-sensitive name path from the tree root. |

## Outputs

| Pin | Type |
| --- | --- |
| Parent Path | String |
| Found | Boolean |

## Notes

- A top-level entry returns an empty path, which stands for the tree root.
- **Found** is false when the entry is missing, and for the tree root itself.
