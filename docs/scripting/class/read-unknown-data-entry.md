---
node: data.readUnknownEntry
---

# Read Unknown Data Entry

Reads an entry's values from a Data Tree that is already loaded, as the Data Definition picked on the node, and returns a copy.

## Inputs

| Pin | Type | Description |
| --- | --- | --- |
| Tree | DataTree Asset | The Data Tree to read. |
| Entry Path | String | The entry's exact, case-sensitive name path from the tree root, such as Weapons/Swords/Iron Sword. |
| Data Definition | DataDefinition Asset | The Data Definition that the entry's values must match. It also sets the type of **Value**, so pick it on the node; it cannot be connected. |

## Outputs

| Pin | Type |
| --- | --- |
| Value | Structure |
| Found | Boolean |

## Notes

- Use it when the tree or entry path comes from a connection. You pick the Data Definition you expect, and **Value** takes its type, so it connects to **Break** *Name* **Data**.
- **Found** is false, and **Value** empty, when the tree or entry is missing, the values are invalid, or the entry uses a different Data Definition. Check it with a [**Branch**](branch.md) before using **Value**.
- To handle a tree whose entries use different Definitions, use one node per Definition on the same path and check each **Found**.
- The tree loads with its Class when it is picked on the node or comes from a variable of this Class. Load any other tree first, with [**Async Load Asset**](async-load-asset.md), or use [**Async Read Unknown Data Entry**](async-read-unknown-data-entry.md).
- Changing **Value** never alters the authored data.
