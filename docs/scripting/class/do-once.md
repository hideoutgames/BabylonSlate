---
node: flow.doOnce
---

# Do Once

Lets execution through the first time only, until it is reset.

## Inputs

| Pin | Type | Description |
| --- | --- | --- |
| In | Exec |  |
| Reset | Exec | Re-arms the node so the next In runs Out again. |

## Outputs

| Pin | Type |
| --- | --- |
| Out | Exec |

## Notes

- Later runs of **In** do nothing until **Reset** runs. After a reset, the next **In** passes through again.
- Each object keeps its own state.
