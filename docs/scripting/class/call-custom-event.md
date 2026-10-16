# Call Custom Event

Runs a custom event on a target object, then continues.

## Inputs

| Pin | Type | Description |
| --- | --- | --- |
| In | Exec |  |
| Target | Object Reference | The object whose event runs. The pin is hidden when the event belongs to this graph's own object. |

## Outputs

| Pin | Type |
| --- | --- |
| Out | Exec |

## Notes

- The event runs straight away. **Out** continues without waiting for any latent node inside the event.
- If the target has no event with that name, nothing happens.
