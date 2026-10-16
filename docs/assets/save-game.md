# Save Game

Typed player progress with defaults, stable fields and reliable local save slots.

## Create

In the **Content Browser**, choose **New Asset > Scripting > Save Game**.

## Editor

Double-tap a Save Game to open it.

- **Fields**: the list of fields. **Add Field** asks for a name; **Search Fields** filters a long list.
- **Inspector**: settings for the selected field, then **Save Setup** and **Advanced** for the whole asset.

## Settings

| Setting | Description |
| --- | --- |
| Name | The field's name. Renaming keeps the value already saved. |
| Type | **Boolean**, **Integer**, **Float**, **String**, **Vector 3**, **Actor Reference** or **Asset Reference**. |
| Container | **Single** or **Array**. |
| Default Value | The value for new games, and when an existing save lacks the field. For an Array, **Add Item** adds entries. |
| Remove Field | Deletes the selected field. |

**Save Setup**

| Setting | Description |
| --- | --- |
| Use As Project Default | Makes this the project's active Save Game. The button then reads **Project Default**. |
| Default Slot | The slot used when a node names none. Shown once this is the project default. |
| Default Profile | Keeps each player's saves together. Shown once this is the project default. |

**Advanced**

| Setting | Description |
| --- | --- |
| Schema Version | Raise it for incompatible changes, then register a migration before **Load Game**. |
| Generated Type | Read-only text that shows the type built from the fields. |

## Notes

- Only the project default Save Game adds per-field **Get Save** and **Set Save** nodes, such as **Get Save Coins**, to **Add Node**. You can also pick it in **Project Settings > Save Games > Default Definition**.
- To save an actor's position and variables, add a [Save Game component](../components/save-game.md) to it.

## Related

- [Save Games](../scripting/save-games.md)
- [Load Game](../scripting/class/load-game.md)
- [Save Game node](../scripting/class/save-game.md)
- [New Game](../scripting/class/new-game.md)
