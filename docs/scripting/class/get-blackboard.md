# Get Blackboard

Returns the value stored under a key in the tree's Blackboard.

## Inputs

| Pin | Type | Description |
| --- | --- | --- |
| Key | String | Name of a key in the Blackboard used by the running tree. |

## Outputs

| Pin | Type | Description |
| --- | --- | --- |
| Out | Any | The value stored for the key. The type is whatever the Blackboard key holds. |

## Notes

- A key with no value returns an empty value.
- Only available in classes based on BTTask, BTDecorator and BTService.
