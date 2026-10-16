# Animation Graph Nodes

Nodes that only exist in Animation Graph event and rule graphs. Rule graphs can also use pure [Class nodes](../class/index.md).

## Events

| Node | Description |
| --- | --- |
| [Event Initialize Animation](event-initialize-animation.md) | Runs once when an Animation Graph component first starts running this graph. |
| [Event Update Animation](event-update-animation.md) | Runs every update, before the state machine checks its transitions. |

## Rules

| Node | Description |
| --- | --- |
| [Enter State](enter-state.md) | Decides whether the transition may enter its target state. |
| [Exit State](exit-state.md) | Decides whether the transition may leave its source state. |

## State

| Node | Description |
| --- | --- |
| [Duration Seconds](duration-seconds.md) | Returns the length in seconds of the current state's clip. |
| [Elapsed Seconds](elapsed-seconds.md) | Returns how many seconds the current state's clip has played. |
| [Exit Time Reached](exit-time-reached.md) | Returns true in the update where the clip passes a given point in time. |
| [Is Looping](is-looping.md) | Returns whether the current state's clip loops. |
| [Just Finished](just-finished.md) | Returns true only in the update where a non-looping clip reaches its end. |
| [Just Looped](just-looped.md) | Returns true only in the update where a looping clip wraps back to the start. |
| [Loop Count](loop-count.md) | Returns how many times the current clip has looped since the state started. |
| [Normalised Time](normalised-time.md) | Returns how far through its clip the current state is, from 0 to 1. |
| [Remaining Ratio](remaining-ratio.md) | Returns the fraction of the current clip still to play, from 1 down to 0. |
| [Remaining Seconds](remaining-seconds.md) | Returns how many seconds are left before the current clip ends or loops. |
