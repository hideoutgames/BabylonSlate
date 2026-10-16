# Set Migration Field

Sets a field of the save being migrated, chosen by its permanent field ID.

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

- Only valid inside [**Event Save Migration**](event-save-migration.md); elsewhere it reports an error.
- The change applies to a staged copy, and the stored save is not rewritten until you save explicitly.
- Actor fields take persistent ID strings.
