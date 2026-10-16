# Event Input Axis

Runs when a chosen Input Axis moves away from zero, stays active or returns to zero.

## Inputs

| Pin | Type | Description |
| --- | --- | --- |
| Input Binding | InputBinding | Selects the Input Axis to listen to. Choose it on the node, or wire an Input Binding to use its Input field. |

## Outputs

| Pin | Type | Description |
| --- | --- | --- |
| Started | Exec | Runs once when the axis moves away from zero. |
| Held | Exec | Runs every tick while the axis is not zero, including the tick it starts. |
| Released | Exec | Runs once when the axis returns to zero. Connect it to stop movement. |
| Value | Float | Current axis value. Several bindings of one axis add together and are clamped to -1 to 1. |
| Held Seconds | Float | Seconds the axis has been away from zero. Zero on the first tick and while the axis is at zero. |
| Last Held Seconds | Float | Length in seconds of the most recent hold that ended. |

## Settings

| Setting | Description |
| --- | --- |
| Input Axis | The Input Axis asset to listen to. Hidden while **Input Binding** is wired. |
| Axis Dimensions | Sets whether **Value** is a single number (1D) or an X and Y pair (2D) when the axis is not chosen on the node. |

## Notes

- Only in event graphs of classes that support [**Event Tick**](event-tick.md), not in functions or Animation Graphs.
- **Value** is a Vector 2 for a 2D axis, and a number from -1 to 1 for a 1D axis.
