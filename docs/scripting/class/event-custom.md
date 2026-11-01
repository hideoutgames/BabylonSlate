---
node: flow.event.custom
---

# Event Custom

Defines an event of your own that other graphs can call by name.

## Outputs

| Pin | Type |
| --- | --- |
| Out | Exec |
| Output Delegate | Delegate |

## Settings

| Setting | Description |
| --- | --- |
| Outputs | The values each caller passes to the event. Each one adds an output pin. |

## Notes

- Trigger it with [**Call Custom Event**](call-custom-event.md). Rename the event and add data outputs in the **Inspector**.
- If the event waits on a latent node such as [**Delay**](delay.md), calls made while it is still waiting are ignored.
- **Output Delegate** is the square at the right end of the title bar. Connect it to [**Bind Event to Event Dispatcher**](bind-event-to-event-dispatcher.md) to run this event whenever the dispatcher is called. An event with no outputs takes the dispatcher's inputs when you connect it; see [Event Dispatchers](../event-dispatchers.md#bind-a-custom-event).
