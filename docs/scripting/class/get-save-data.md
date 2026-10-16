# Get Save Data

Returns the current values of the default Save Game as one record.

## Outputs

| Pin | Type |
| --- | --- |
| Save Data | Any |

## Notes

- The values live in memory; [**Save Game**](save-game.md) writes them to storage.
- Needs a default Save Game, chosen in **Project Settings &gt; Save Games**.
- Each field of the default Save Game also gets its own Get and Set node with a typed pin.
