# Set Save Field

Sets the value of a Save Game field in memory, chosen by its permanent field ID.

## Inputs

| Pin | Type | Description |
| --- | --- | --- |
| Exec | Exec |  |
| Field ID | String | The field's permanent ID, which stays the same when the field is renamed. |
| Value | Any |  |

## Outputs

| Pin | Type |
| --- | --- |
| Then | Exec |

## Notes

- The value is checked against the field's type, and a mismatch or unknown **Field ID** reports an error.
- It reaches storage only when [**Save Game**](save-game.md) runs.
- Each field of the default Save Game also appears in **Add Node** as its own Set Save node with a typed pin.
