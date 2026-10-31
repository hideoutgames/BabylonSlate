---
node: flow.dispatcher.unbind
---

# Unbind Event from Event Dispatcher

Removes an event from an Event Dispatcher.

## Inputs

| Pin | Type | Description |
| --- | --- | --- |
| In | Exec |  |
| Target | Object Reference | The object whose dispatcher the event is removed from. For a dispatcher of this graph's own class the pin shows **Self**. |
| Event | Delegate | The event to remove. Any delegate for the same event of the same object removes it. |

## Outputs

| Pin | Type |
| --- | --- |
| Out | Exec |

## Notes

- **Add Node** names it after the dispatcher, such as **Unbind Event from On Damaged**.
- Removing an event that is not bound does nothing.
