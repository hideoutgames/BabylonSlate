---
node: flow.sequence
---

# Sequence

Runs its outputs one after another, from the first to the last.

## Inputs

| Pin | Type |
| --- | --- |
| In | Exec |

## Outputs

| Pin | Type |
| --- | --- |
| Then 0 | Exec |
| Then 1 | Exec |

## Settings

| Setting | Description |
| --- | --- |
| Outputs | How many Then outputs the node has, from 1 up to 32. A new Sequence has 2. |

## Notes

- Select **+ Add Pin** below the outputs to add one, or change **Outputs** in the **Inspector** to add or remove several. Lowering it removes the last outputs and the wires leaving them.
- Right-click any pin of the node for **Add Pin**, or an output for **Remove Pin** while there are at least two: it removes that output, and the outputs after it move up one, keeping their wires.
- Each output finishes before the next one starts, including any latent node such as [**Delay**](delay.md) on that path.
- Outputs are numbered from 0, so **Then 0** runs first.
