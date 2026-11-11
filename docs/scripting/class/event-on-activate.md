---
node: bt.event.activate
---

# Event On Activate

Runs once when the Behaviour Tree starts this task.

## Outputs

| Pin | Type |
| --- | --- |
| Out | Exec |

## Notes

- Only available in classes based on BTTask.
- [**Event On Tick**](event-on-tick.md) runs in the same update, so you can start the work here and call [**Finish Execute**](finish-execute.md) when it is done.
