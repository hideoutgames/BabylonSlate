---
node: flow.dispatcher.bind
---

# Bind Event to Event Dispatcher

Adds an event to an Event Dispatcher, so each Call runs it.

## Inputs

| Pin | Type | Description |
| --- | --- | --- |
| In | Exec |  |
| Target | Object Reference | The object whose dispatcher the event is added to. For a dispatcher of this graph's own class the pin shows **Self**. |
| Event | Delegate | The event to run: a custom event's **Output Delegate** or a [Create Event](create-event.md) node. It takes the dispatcher's inputs. |

## Outputs

| Pin | Type |
| --- | --- |
| Out | Exec |

## Notes

- **Add Node** names it after the dispatcher, such as **Bind Event to On Damaged**. **Assign On Damaged** adds it together with a matching custom event.
- Binding the same event of the same object again keeps one binding.
- An empty **Target** or **Event** does nothing and reports an error.
