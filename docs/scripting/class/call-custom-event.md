---
node: flow.event.call
---

# Call Custom Event

Runs a custom event on a target object, then continues.

## Inputs

| Pin | Type | Description |
| --- | --- | --- |
| In | Exec |  |
| Target | Object Reference | The object whose event runs. For an event of this graph's own class the pin reads **Target (Self)** and runs it on the object running the graph; connect another object of the class to run it there. An event of another class needs the pin connected. |

## Outputs

| Pin | Type |
| --- | --- |
| Out | Exec |

## Notes

- The event runs straight away. **Out** continues without waiting for any latent node inside the event.
- If the target has no event with that name, nothing happens. An empty **Target** also does nothing and logs an error.
