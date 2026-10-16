---
node: flow.branch
---

# Branch

Runs one of two paths depending on a condition.

## Inputs

| Pin | Type | Description |
| --- | --- | --- |
| In | Exec |  |
| Condition | Boolean | When true, **True** runs. Otherwise **False** runs. |

## Outputs

| Pin | Type |
| --- | --- |
| True | Exec |
| False | Exec |

## Notes

- Only one output runs each time the node executes.
