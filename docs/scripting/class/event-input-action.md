# Event Input Action

Runs when a chosen Input Action starts, stays held or is released.

## Inputs

| Pin | Type | Description |
| --- | --- | --- |
| Input Binding | InputBinding | Selects the Input Action to listen to. Choose it on the node, or wire an Input Binding to use its Input field. |

## Outputs

| Pin | Type | Description |
| --- | --- | --- |
| Started | Exec | Runs once when the action becomes active. |
| Held | Exec | Runs every tick while the action is active, including the tick it starts. |
| Released | Exec | Runs once when the action stops being active. |
| Value | Boolean | True while the action is active. Several bindings of one action combine. |
| Held Seconds | Float | Seconds the current hold has lasted. Zero on the first tick and while the action is inactive. |
| Last Held Seconds | Float | Length in seconds of the most recent hold that ended. |

## Settings

| Setting | Description |
| --- | --- |
| Input Action | The Input Action asset to listen to. Hidden while **Input Binding** is wired. |

## Notes

- Only in event graphs of classes that support [**Event Tick**](event-tick.md), not in functions or Animation Graphs.
- A tap that starts and ends between two ticks runs both **Started** and **Released**.
