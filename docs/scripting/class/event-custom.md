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

- In **Add Node** this node is **Create New Custom Event…**. The new event is named **NewEvent** (or the first free **NewEvent_1**, **NewEvent_2**, …), and its name opens for editing in the **Class** window.
- Trigger it with [**Call Custom Event**](call-custom-event.md). Add data outputs in the **Inspector**. Double-click its title, or choose **Rename Event** in the node menu or the **Inspector**, to rename it on the node; see [Custom events](../events.md#custom-events).
- Every call runs the event, even while an earlier call still waits on a latent node such as [**Delay**](delay.md). Each call waits on its own.
- **Output Delegate** is the square at the right end of the title bar. Connect it to [**Bind Event To Event Dispatcher**](bind-event-to-event-dispatcher.md) to run this event whenever the dispatcher is called. An event with no outputs takes the dispatcher's inputs when you connect it; see [Event Dispatchers](../event-dispatchers.md#bind-a-custom-event).
