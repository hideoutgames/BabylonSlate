# Event Update Animation

Runs every update, before the state machine checks its transitions.

## Outputs

| Pin | Type | Description |
| --- | --- | --- |
| Out | Exec |  |
| Delta Seconds | Float | Seconds since the previous update, including any time dilation. |

## Notes

- Only available in the Animation Object graph of an Animation Graph asset (the **Animation Object** view).
- Variables set here are seen by transition rules in the same update.
