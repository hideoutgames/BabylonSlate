# On Abort

Runs when the Behaviour Tree stops this task before it finishes.

## Outputs

| Pin | Type |
| --- | --- |
| Out | Exec |

## Notes

- Use it to clean up, for example by stopping movement or resetting Blackboard values.
- Only available in classes based on BTTask. [**Finish Execute**](finish-execute.md) has no effect here.
