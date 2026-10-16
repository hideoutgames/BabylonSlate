# Get Save Field

Returns the value of a Save Game field, chosen by its permanent field ID.

## Inputs

| Pin | Type | Description |
| --- | --- | --- |
| Field ID | String | The field's permanent ID, which stays the same when the field is renamed. |

## Outputs

| Pin | Type |
| --- | --- |
| Value | Any |

## Notes

- Each field of the default Save Game also appears in **Add Node** as its own Get Save node, with a typed pin and no ID to enter.
- An unknown **Field ID** reports an error.
- The value comes from memory, so run [**Load Game**](load-game.md) first to read saved progress.
