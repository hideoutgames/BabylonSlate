---
node: flow.event.custom
---

# Event Custom

Defines an event of your own that other graphs can call by name.

## Outputs

| Pin | Type |
| --- | --- |
| Out | Exec |

## Settings

| Setting | Description |
| --- | --- |
| Outputs | The values each caller passes to the event. Each one adds an output pin. |

## Notes

- Trigger it with [**Call Custom Event**](call-custom-event.md). Rename the event and add data outputs in the **Inspector**.
- If the event waits on a latent node such as [**Delay**](delay.md), calls made while it is still waiting are ignored.
