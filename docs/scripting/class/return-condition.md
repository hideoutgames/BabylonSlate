---
node: bt.returnCondition
---

# Return Condition

Sets whether a decorator allows its branch to run.

## Inputs

| Pin | Type | Description |
| --- | --- | --- |
| In | Exec |  |
| Condition | Boolean | True lets the branch run; false blocks it. Left unconnected, it counts as false. |

## Outputs

| Pin | Type |
| --- | --- |
| Out | Exec |

## Notes

- It does not stop the graph. If it is called more than once, the last value is used.
- Only available in classes based on BTDecorator.
