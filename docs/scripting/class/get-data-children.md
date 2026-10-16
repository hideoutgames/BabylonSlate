# Get Data Children

Returns the paths of an entry's immediate children, in sibling order.

## Inputs

| Pin | Type | Description |
| --- | --- | --- |
| Tree | DataTree Asset |  |
| Entry Path | String | The entry's exact, case-sensitive name path. Empty selects the tree root. |

## Outputs

| Pin | Type |
| --- | --- |
| Entry Paths | Array of String |
| Found | Boolean |

## Notes

- An empty **Entry Path** selects the tree root.
- **Found** is true for any entry in the tree, including grouping entries with no Data Definition, and false for a missing entry or a tree that is not loaded.
