---
node: flow.dispatcher.call
---

# Call Event Dispatcher

Runs every event bound to an Event Dispatcher, in the order they were bound, then continues.

## Inputs

| Pin | Type | Description |
| --- | --- | --- |
| In | Exec |  |
| Target | Object Reference | The object whose dispatcher runs. For a dispatcher of this graph's own class the pin shows **Self**; connect another object to call its dispatcher. |

## Outputs

| Pin | Type |
| --- | --- |
| Out | Exec |

## Notes

- **Add Node** names it after the dispatcher, such as **Call On Damaged**, and it has one input for each of the dispatcher's inputs.
- **Out** continues once every bound event has started. Latent nodes inside them do not hold it up.
- With nothing bound it does nothing. See [Event Dispatchers](../event-dispatchers.md#how-a-call-runs).
