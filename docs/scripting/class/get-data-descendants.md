---
node: data.getDescendants
---

# Get Data Descendants

Returns the paths of every entry below an entry, with parents listed before their children.

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

- The selected entry itself is not included. An empty **Entry Path** selects the tree root and lists every entry.
- **Found** is true for any entry in the tree, including grouping entries with no Data Definition, and false for a missing entry or a tree that is not loaded.
