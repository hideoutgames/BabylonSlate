# Move Data Subtree

Moves an entry and its children under a new parent in a Data Tree.

## Inputs

| Pin | Type | Description |
| --- | --- | --- |
| Exec | Exec |  |
| Data Tree | DataTree Asset |  |
| Entry Path | String | The exact name path of the entry to move. |
| New Parent Path | String | The new parent's exact name path. Empty moves the entry to the top level. |
| Index | Integer | The position among the new siblings. -1 adds the entry last. |

## Outputs

| Pin | Type | Description |
| --- | --- | --- |
| Then | Exec |  |
| Success | Boolean |  |
| Error | String |  |
| Entry Path | String | The entry's new path. |

## Notes

- Values and child order are kept; a move that would create a loop or a duplicate sibling name fails.
- **Index** -1 appends at the end; other values count from zero and must fall within the parent's children.
- Only in Editor Utility graphs; check **Success** before using **Entry Path**.
- Latent: the node finishes later without pausing the rest of the game.
- Editor Utility graphs only.
