# Add Impulse

Applies an instant push to an actor's dynamic Rigid Body.

## Inputs

| Pin | Type | Description |
| --- | --- | --- |
| In | Exec |  |
| Target | Actor Reference |  |
| Impulse | Vector 3 |  |
| Strength | Float | Multiplies the impulse. Defaults to 1. |

## Outputs

| Pin | Type |
| --- | --- |
| Out | Exec |

## Notes

- The push is **Impulse** multiplied by **Strength**, applied at the body's centre of mass in world directions.
- Nothing happens unless the actor has a Rigid Body whose motion type is Dynamic.
