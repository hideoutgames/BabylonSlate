# Set Blackboard

Stores a value under a key in the tree's Blackboard.

## Inputs

| Pin | Type | Description |
| --- | --- | --- |
| In | Exec |  |
| Key | String | Name of a key in the Blackboard used by the running tree. |
| Value | Any |  |

## Outputs

| Pin | Type |
| --- | --- |
| Out | Exec |

## Notes

- Nodes that read the key afterwards see the new value.
- Only available in classes based on BTTask, BTDecorator and BTService.
