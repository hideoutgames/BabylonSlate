---
node: timers.setTimerByEvent
---

# Set Timer By Event

Runs Event after Time seconds of game time, and again every Time seconds while Looping is on. Returns a Handle for the other Timer nodes.

## Inputs

| Pin | Type | Description |
| --- | --- | --- |
| In | Exec |  |
| Event | Delegate |  |
| Time | Float | Seconds between runs. |
| Looping | Boolean | Run again every Time seconds until cleared. |
| Initial Start Delay | Float | Extra seconds before the first run. |

## Outputs

| Pin | Type | Description |
| --- | --- | --- |
| Out | Exec |  |
| Handle | Timer Handle | Names the timer for the other Timer nodes. |

## Notes

- Connect a custom event's Output Delegate, or [Create Event](create-event.md), to **Event**.
- Time is game time: it follows [Set Time Dilation](set-time-dilation.md) and holds while the game is paused, unless the actor ticks on pause.
- **Initial Start Delay** adds seconds before the first run only; later runs come every **Time** seconds.
- A **Time** of 0 or less sets no timer and returns an empty handle.
- The timer ends when the actor that set it, or the event's object, is destroyed, and when Play stops.
- A looping timer shorter than a frame runs its event several times in that frame, at most 64.
