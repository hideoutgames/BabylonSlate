# On Activate

Runs once when the Behaviour Tree starts this task.

## Outputs

| Pin | Type |
| --- | --- |
| Out | Exec |

## Notes

- Only available in classes based on BTTask.
- [**On Tick**](on-tick.md) runs in the same update, so you can start the work here and call [**Finish Execute**](finish-execute.md) when it is done.
