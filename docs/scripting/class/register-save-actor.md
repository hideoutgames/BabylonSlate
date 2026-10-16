# Register Save Actor

Registers a spawned actor so its state is saved and restored with the game.

## Inputs

| Pin | Type | Description |
| --- | --- | --- |
| Exec | Exec |  |
| Actor | Actor Reference |  |
| Persistent ID | String | A stable ID for the actor. Set it before the first save; empty uses a generated ID that changes each session. |

## Outputs

| Pin | Type |
| --- | --- |
| Then | Exec |

## Notes

- Give it a **Persistent ID** that stays the same between sessions so the actor reconnects when the game loads.
- The actor's Save Game component selects which state is saved.
- Reports an error if the actor is destroyed or no default Save Game is set.
