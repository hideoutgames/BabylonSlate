# Get Migration Field

Reads a field of the save being migrated, chosen by its permanent field ID.

## Inputs

| Pin | Type | Description |
| --- | --- | --- |
| Field ID | String | The field's permanent ID, which stays the same when the field is renamed. |

## Outputs

| Pin | Type |
| --- | --- |
| Value | Any |

## Notes

- Only valid inside [**Event Save Migration**](event-save-migration.md); elsewhere it reports an error.
- It can also read fields that were removed from the current Save Game.
- Actor references are persistent ID strings here, because actors are not restored yet.
