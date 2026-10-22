# Data Tree

A hierarchy of named, typed entries. Branches can use different Data Definitions, and scripts read entries by path.

## Create

1. In the **Content Browser**, choose **New Asset > Data > Data Tree**.
2. Enter a **Name**.
3. Optionally pick a **Default Definition**: the [Data Definition](data-definition.md) that entries use unless they set their own.

## Editor

Double-tap a Data Tree to open it.

- **Tree**: the hierarchy. **Default Definition** sets the tree's Definition. **Search Tree** filters it; **Add Root** and **Add Child** add entries. Each entry has a menu with **Add Child**, **Rename**, **Move To**, **Move Up**, **Move Down**, **Duplicate Subtree** and **Remove Subtree**.
- **Entries**: the entries of one branch as a table. **New Entry** adds one, **Search Entries** filters them, and cells edit values in place. The **View** menu holds **Include Descendants**, **Filter**, **Columns**, **Clear Sort** and **Copy Entry Values**. **Columns** is available when the listed entries share a Definition with fields.
- **Values**: the selected entry's Definition and field values.
- **Validation**: problems in the hierarchy or the values.

## Settings

| Setting | Description |
| --- | --- |
| Default Definition | The Data Definition for the whole tree. An entry uses the nearest Definition set on itself, its parents or the tree. |
| Entry Definition | In **Values**, overrides the Definition for one entry and its children. **Use Parent Definition** clears the override. An entry with no Definition is untyped and shows no value fields. |
| Values | One editor per field of the entry's Definition. |

## Notes

- Scripts find entries by their name path from the root, such as `Weapons/Swords/Iron Sword`. Paths are case-sensitive. Renaming or moving an entry changes its path.
- New entries start from the Definition's defaults, then keep their own values.
- When a Definition changes, an entry shows **Definition Changed**. Choose **Review Changes** to update its fields.

## Related

- [Data Definitions and Data Trees](../scripting/data.md)
- [Data Definition](data-definition.md)
- [Read Data Entry](../scripting/class/read-data-entry.md)
- [Read Data Entry Async](../scripting/class/read-data-entry-async.md)
