---
node: editorData.updateEntry
---

# Update Data Entry

Changes the values of an existing Data Tree entry.

## Inputs

| Pin | Type | Description |
| --- | --- | --- |
| Exec | Exec |  |
| Data Tree | DataTree Asset |  |
| Entry Path | String | The entry's exact, case-sensitive name path from the tree root. |
| Values | Structure | The values to change. Fields you leave out keep their current values. |

## Outputs

| Pin | Type | Description |
| --- | --- | --- |
| Completed | Exec |  |
| Failed | Exec |  |
| Error | String | Why the node failed; empty on success. |
| Entry Path | String | The path of the updated entry. |

## Settings

| Setting | Description |
| --- | --- |
| Data Definition | The Data Definition that the entry must use. It also shapes the **Values** input. |

## Notes

- The change is one undoable edit; nested scalar fields merge, while arrays and maps you supply replace their contents.
- Fails if the entry uses a different Data Definition from the node, or still needs the Definition's changes applied.
- Only in Editor Utility graphs; use **Entry Path** from **Completed**.
- Latent: the node finishes later without pausing the rest of the game.
- Editor Utility graphs only.
