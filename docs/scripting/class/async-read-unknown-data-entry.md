---
node: data.readEntryAsync
---

# Async Read Unknown Data Entry

Loads a Data Tree and the Data Definition picked on the node in the background, then reads one entry from it.

## Inputs

| Pin | Type | Description |
| --- | --- | --- |
| Exec | Exec |  |
| Tree | DataTree Asset | The Data Tree to read. |
| Entry Path | String | The entry's exact, case-sensitive name path from the tree root, such as Weapons/Swords/Iron Sword. |
| Data Definition | DataDefinition Asset | The Data Definition that the entry's values must match. It also sets the type of **Value**, so pick it on the node; it cannot be connected. |

## Outputs

| Pin | Type |
| --- | --- |
| Completed | Exec |
| Failed | Exec |
| Value | Structure |
| Found | Boolean |
| Error | String |

## Notes

- Use it for a tree chosen while the game runs that may not be loaded yet, such as one returned by another object or an Asset Registry search.
- Connect **Value** to **Break** *Name* **Data**, where *Name* is the Data Definition you picked.
- Runs **Completed** once the read finishes, even when **Found** is false; runs **Failed** with an **Error** only if the tree cannot be loaded.
- **Found** is false when the entry is missing, its values are invalid, or it uses a different Data Definition.
- **Value** is a copy, so changing it never alters the authored data.
- A tree that loads with its Class can use [**Read Unknown Data Entry**](read-unknown-data-entry.md) instead. That covers a tree picked on the node, or one from a variable of this Class.
- Latent: the node finishes later without pausing the rest of the game.
