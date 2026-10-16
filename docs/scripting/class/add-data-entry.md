# Add Data Entry

Adds a new entry to a Data Tree under a parent entry.

## Inputs

| Pin | Type | Description |
| --- | --- | --- |
| Exec | Exec |  |
| Data Tree | DataTree Asset |  |
| Parent Path | String | The parent entry's exact name path. Empty adds the entry at the top level. |
| Name | String | The new entry's name. It must be unique among its siblings, ignoring case, and cannot contain a slash. |

## Outputs

| Pin | Type | Description |
| --- | --- | --- |
| Then | Exec |  |
| Success | Boolean |  |
| Error | String |  |
| Entry Path | String | The path of the new entry. |

## Settings

| Setting | Description |
| --- | --- |
| Definition Mode | Use Parent / Tree inherits the Data Definition, Override sets one, and None (Grouping Entry) makes an entry without values. |
| Data Definition | The Data Definition for typed values. With Use Parent / Tree, select the parent's Definition to author values, or leave it empty to copy its defaults. |

## Notes

- The change is one undoable edit on the open tree; save the tree to keep it.
- Defaults are copied once when the entry is created, and values never inherit from the parent.
- Only in Editor Utility graphs; check **Success** before using **Entry Path**.
- Latent: the node finishes later without pausing the rest of the game.
- Editor Utility graphs only.
