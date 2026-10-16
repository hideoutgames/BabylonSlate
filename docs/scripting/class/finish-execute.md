# Finish Execute

Ends the running task and reports success or failure to the Behaviour Tree.

## Inputs

| Pin | Type | Description |
| --- | --- | --- |
| In | Exec |  |
| Success | Boolean | True finishes the task as a success; false finishes it as a failure. Left unconnected, it counts as false. |

## Outputs

| Pin | Type |
| --- | --- |
| Out | Exec |

## Notes

- A task keeps running until it reaches this node, so connect it on every path that should finish the task.
- Only available in classes based on BTTask.
