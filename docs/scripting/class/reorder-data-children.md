# Reorder Data Children

Sets the order of an entry's immediate children in a Data Tree.

## Inputs

| Pin | Type | Description |
| --- | --- | --- |
| Exec | Exec |  |
| Data Tree | DataTree Asset |  |
| Parent Path | String | The parent entry's exact name path. Empty reorders the top-level entries. |
| Entry Paths | Array of String | The children's paths in the new order. |

## Outputs

| Pin | Type | Description |
| --- | --- | --- |
| Then | Exec |  |
| Success | Boolean |  |
| Error | String |  |
| Data Tree | DataTree Asset | The Data Tree that was reordered. |

## Notes

- Include every immediate child path exactly once, or the operation fails.
- The change is one undoable edit on the open tree.
- Only in Editor Utility graphs; check **Success** before using the result.
- Latent: the node finishes later without pausing the rest of the game.
- Editor Utility graphs only.
