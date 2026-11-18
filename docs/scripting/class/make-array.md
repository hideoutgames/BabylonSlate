---
node: array.make
---

# Make Array

Builds an array from its item inputs. A new Make Array has one item input.

## Inputs

| Pin | Type |
| --- | --- |
| Item 0 | Wildcard |

## Outputs

| Pin | Type |
| --- | --- |
| Out | Array of Wildcard |

## Settings

| Setting | Description |
| --- | --- |
| Items | How many item inputs the node has, from 0 up to 32. A new Make Array has 1. |

## Notes

- Select **+ Add Pin** below the item inputs to add one, or change **Items** in the **Inspector** to add or remove several. Lowering **Items** removes the last inputs and the wires into them. Set it to 0 for an empty array.
- Items are placed in pin order, with Item 0 first.
- All items share one type, which follows what you connect to them.
