# Event Save Migration

Updates a staged copy of an older save while Load Game runs.

## Outputs

| Pin | Type | Description |
| --- | --- | --- |
| Then | Exec |  |
| From Version | Integer | The save schema version this step upgrades from. |

## Notes

- Runs once for each step registered with [**Register Save Migration**](register-save-migration.md). Register the steps before you call [**Load Game**](load-game.md).
- An error in the event cancels loading and keeps the original save.
