# Data Definitions and Data Trees

A Data Definition describes a typed record, such as a weapon's damage, price and icon. A Data Tree holds many named entries of such records in a hierarchy, and scripts read them by path.

## Set up the data

1. In the **Content Browser**, choose **New Asset > Data > Data Definition**. In **Fields**, choose **Add Field** for each value, then set its type, default value and rules such as **Required** in the **Inspector**. See [Data Definition](../assets/data-definition.md).
2. Choose **New Asset > Data > Data Tree** and optionally pick a **Default Definition**.
3. Open the tree. In **Tree**, add root and child entries. Select an entry and fill in its fields in **Values**. **Entries** shows a branch as a table, and **Validation** lists problems. See [Data Tree](../assets/data-tree.md).

An entry uses the nearest Data Definition set on itself, its parents or the tree. Set an entry's Definition to None to make it a grouping branch with no values. New entries start from the Definition's defaults; after that each entry keeps its own values.

## Entry paths

Scripts find entries by their name path from the tree root, such as `Weapons/Swords/Iron Sword`.

- Paths are exact and case-sensitive. They leave out the tree's own name and have no leading or trailing slash.
- An empty path means the tree root.
- Renaming or moving an entry changes its path and the paths of its children. Nodes that still use an old path show it as missing until you pick the entry again.

## Read data in scripts

For each Data Definition, **Add Node** lists a typed **Read** *Name* **Data** node, such as **Read Weapon Data**. See [Read Data Entry](class/read-data-entry.md).

1. Place the node and choose the **Tree**. The **Entry Path** picker then lists the tree's entries.
2. Use **Value**, the entry's fields as one record. Wire it into **Break** *Name* **Data** to get each field.
3. Check **Found** with a [Branch](class/branch.md) first. It is false when the entry is missing or uses another Definition.

| Node | What it does |
| --- | --- |
| [Read Data Entry](class/read-data-entry.md) | Reads one entry from a tree that is already loaded. |
| [Read Data Entry Async](class/read-data-entry-async.md) | Loads a tree chosen while the game runs, then reads one entry. |
| [Get Data Children](class/get-data-children.md), [Get Data Descendants](class/get-data-descendants.md) | Return the paths below an entry, for example to loop over every weapon. |
| [Get Data Parent](class/get-data-parent.md) | Returns the path of an entry's parent. |

A tree chosen on the node loads with its class. A tree passed in while the game runs must be loaded first, with **Read Data Entry Async** or [Async Load Asset](class/async-load-asset.md).

## Records in variables

A Data Definition also works as a type. Choose **Structure / Data Definition** as a variable's type, then pick the Definition under **Record Type**. **Make** *Name* **Data** builds a record and **Break** *Name* **Data** splits one into its fields.

## Notes

- **Value** is a copy. Changing it in a script never changes the Data Tree asset.
- Editor tools can create and edit Data Trees with the editable data nodes; see [Editor Scripting](editor-scripting.md).
- For one small record type, a [Structure](structures-and-enums.md) is simpler.
