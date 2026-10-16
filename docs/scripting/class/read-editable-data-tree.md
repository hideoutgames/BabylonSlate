# Read Editable Data Tree

Returns the paths of every entry in a Data Tree, including unsaved edits.

## Inputs

| Pin | Type |
| --- | --- |
| Exec | Exec |
| Data Tree | DataTree Asset |

## Outputs

| Pin | Type |
| --- | --- |
| Then | Exec |
| Success | Boolean |
| Error | String |
| Entry Paths | Array of String |

## Notes

- Parents are listed before their children, in tree order.
- Paths change when entries are renamed or moved, so read them again after editing.
- Only in Editor Utility graphs; check **Success** before using the paths.
- Latent: the node finishes later without pausing the rest of the game.
- Editor Utility graphs only.
