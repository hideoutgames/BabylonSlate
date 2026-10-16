# On Evaluate

Runs when the Behaviour Tree checks this decorator's condition.

## Outputs

| Pin | Type |
| --- | --- |
| Out | Exec |

## Notes

- Call [**Return Condition**](return-condition.md) to allow or block the branch. If it is never called, the condition counts as true.
- Only available in classes based on BTDecorator.
