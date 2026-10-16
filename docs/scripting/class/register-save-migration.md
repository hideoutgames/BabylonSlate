---
node: saveGame.registerMigration
---

# Register Save Migration

Registers a step that upgrades saves from an older Save Game schema version.

## Inputs

| Pin | Type | Description |
| --- | --- | --- |
| Exec | Exec |  |
| From Version | Integer | The older schema version this step upgrades from. Each step moves a save up by one version. |

## Outputs

| Pin | Type |
| --- | --- |
| Then | Exec |

## Notes

- Register during [**Event On Init**](event-on-init.md) or [**Event Begin Play**](event-begin-play.md), before [**Load Game**](load-game.md).
- [**Event Save Migration**](event-save-migration.md) runs for each registered step and can edit the staged fields.
- If you register any step, register every step up to the current schema version.
