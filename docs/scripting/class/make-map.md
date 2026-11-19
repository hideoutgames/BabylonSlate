---
node: map.make
---

# Make Map

Builds a map from key and value pairs. A new Make Map has one pair.

## Inputs

| Pin | Type |
| --- | --- |
| Key 0 | Wildcard |
| Value 0 | Wildcard |

## Outputs

| Pin | Type |
| --- | --- |
| Out | Map of Wildcard to Wildcard |

## Settings

| Setting | Description |
| --- | --- |
| Pairs | How many key and value pairs the node has, from 0 up to 32. A new Make Map has 1. |

## Notes

- Select **+ Add Pin** below the pairs to add one, or change **Pairs** in the **Inspector** to add or remove several. Lowering **Pairs** removes the last pairs and the wires into them. Set it to 0 for an empty map.
- Right-click any pin of the node for **Add Pin**, or a key or value input for **Remove Pin**: it removes that pair, and the pairs after it move up one, keeping their wires and values.
- All keys share one type and all values share another, set by what you connect.
- If two pairs use the same key, the later pair wins.
