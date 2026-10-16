# Exit State

Decides whether the transition may leave its source state.

## Inputs

| Pin | Type | Description |
| --- | --- | --- |
| Value | Boolean | True lets the transition leave the source state. |

## Notes

- A transition fires only when both [**Enter State**](enter-state.md) and **Exit State** are true. An unconnected input counts as true.
- For a one-way transition, this node is dimmed and always counts as true.
