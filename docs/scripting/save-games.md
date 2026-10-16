# Save Games

A Save Game stores a player's progress, such as coins or the last checkpoint, in local save slots and restores it later.

## Set up a Save Game

1. In the **Content Browser**, choose **New Asset > Scripting > Save Game** and open it.
2. In **Fields**, choose **Add Field** and enter a name.
3. Select the field. In the **Inspector**, set its **Type**, **Container** (**Single** or **Array**) and **Default Value**.
4. Under **Save Setup**, choose **Use As Project Default**. You can also pick it in **Project Settings > Save Games > Default Definition**.
5. Optionally change **Default Slot** and **Default Profile**. Use profiles to keep several players' saves apart, and slots for manual saves.

Fields can be Boolean, Integer, Float, String, Vector 3, Actor Reference or Asset Reference, or an array of one of these. Renaming a field keeps existing saves working. When an older save loads, fields it does not have get their default value.

## Save and load

When a Save Game is the project default, **Add Node** lists a **Get Save** and **Set Save** node for each of its fields, such as **Get Save Coins**.

A typical setup, in your [Game Instance](game-instance.md) class:

1. Connect [Event On First Scene Loaded](class/event-on-first-scene-loaded.md) to [Load Game](class/load-game.md).
2. On **Failed**, check **Error Code**. `missing` means there is no save yet: call [New Game](class/new-game.md). Any other code means the save cannot be used: show **Error Message**.
3. During play, update fields with the **Set Save** nodes and call [Save Game](class/save-game.md) at checkpoints.
4. Read progress with the **Get Save** nodes.

Leave **Slot** and **Profile** empty to use the defaults. Other nodes: [List Saves](class/list-saves.md), [Delete Save](class/delete-save.md), [Get Save Data](class/get-save-data.md), [Get Save Field](class/get-save-field.md) and [Set Save Field](class/set-save-field.md).

Save at checkpoints after meaningful progress. Closing or switching away from the app is not a reliable moment to finish a save.

## Errors

| Error Code | Meaning |
| --- | --- |
| `missing` | No save exists in that slot. Offer a new game. |
| `corrupt` | The stored save is damaged. Keep it, and offer to delete it with **Delete Save**. |
| `incompatible` | The save was made by a different Save Game or schema version that this build cannot load. |
| `storage-full` | The device rejected the write. The previous save is kept. |
| `unavailable` | Save storage cannot be used on this device. |
| `invalid` | The request or a field value is not valid. |
| `apply-failed` | The save was valid but could not be restored to the game. |

A failed save keeps the last valid save, and a failed load leaves the game as it was.

## Save actors

To save an actor's position and selected variables, add a [Save Game](../components/save-game.md) component to it (**Add Component > General > Save Game**) and pick what to save. Actors spawned during play also need [Register Save Actor](class/register-save-actor.md) with a persistent ID. [Event On Game Loaded](class/event-on-game-loaded.md) runs after a load has restored them.

Saved actors belong to the scene that is active when you save; switch to that scene before loading. Actors in streamed scenes and Scene Layers are not saved. Store progress that spans scenes in Save Game fields.

## Change the format

Renaming a field or adding one with a default needs no extra work. For other changes, such as new units, raise **Advanced > Schema Version** in the Save Game's **Inspector**, then:

1. In **Event On Init**, before **Load Game**, call [Register Save Migration](class/register-save-migration.md) with **From Version** set to the old version.
2. Handle [Event Save Migration](class/event-save-migration.md) and convert values with the **Get Migration** and **Set Migration** field nodes, or [Get Migration Field](class/get-migration-field.md) and [Set Migration Field](class/set-migration-field.md).
3. Register a step for every version up to the current one.

## Test saves in the editor

Play and Preview Build share a set of preview saves, separate from the saves of your exported game. Manage them in **Project Settings > Save Games**:

- **Wipe Preview Saves On Play** starts every Play session without saves.
- **Preview Saves** lists the saves of a **Profile**. Use **Inspect**, **Export Save** and **Delete Save** on a save, or **Import Save** to test recovery.
- **Reset Preview Saves** removes all preview saves.
- **Request Persistent Storage** asks the browser not to clear saves automatically. The browser can refuse.
