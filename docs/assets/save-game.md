# Save Game

Typed player progress with defaults, stable fields and reliable local save slots.

## Create

In the **Content Browser**, choose **New Asset > Scripting > Save Game**.

## Editor

Double-tap a Save Game to open it.

- **Fields**: the list of fields. **Add Field** opens a list of field types; pick one to add a field named **NewField** (then **NewField_1**, and so on) with its name ready to type. **Search Fields** filters a long list.
- To rename a field, double-tap its name in **Fields**, or select it and press **F2**. Type the new name, then press **Enter** or tap elsewhere; **Escape** keeps the old name.
- **Inspector**: settings for the selected field, then **Save Setup** and **Advanced** for the whole asset.

## Fields from a Data Definition

To manage a Save Game's fields in one place, choose a **Data Definition** under **Advanced**, or right-click a Data Definition in the **Content Browser** and choose **Create Linked Save Game**. The Save Game then takes its fields, their types and their default values from that Data Definition, and every change you make there reaches the Save Game.

- **Add Field**, **Name**, renaming and **Remove Field** are gone; **Type** and **Container** are read-only. The **Open** button at the top of **Fields**, named after the Data Definition, opens it to edit the fields.
- You can still change a field's **Default Value** here. **Use Data Definition Default** goes back to the Data Definition's value.
- If the Save Game already has its own fields, it asks before replacing them. Values saved for those fields won't load.
- Fields a save can't hold, such as a Structure with object references, are listed under **Fields Not Saved**.
- Choosing **None** turns this off and keeps the current fields, so existing saves still load.

## Settings

| Setting | Description |
| --- | --- |
| Name | The field's name. Renaming keeps the value already saved. |
| Type | **Boolean**, **Integer**, **Float**, **String**, **Tag**, **TagContainer**, **Enum**, **Vector2**, **Vector3**, **Vector4**, **Rotator**, **Quaternion**, **Color**, **Transform**, **Actor Reference**, **Class Reference**, **Asset Reference** or **Structure**. |
| Structure | For a **Structure** field, the Structure it holds, such as **Int Range** or **Float Curve**. Only Structures without object references can be saved, nested Structures included. |
| Enum | For an **Enum** field, the Enum it holds. The field saves the member's name. |
| Container | **Single**, **Array** or **Map**. |
| Key Type | For a **Map**, the type of its keys: **Integer**, **Float**, **String**, **Tag**, **Enum**, **Class Reference** or **Asset Reference**. Each key appears once. |
| Default Value | The value for new games, and when an existing save lacks the field. For an Array, **Add Item** adds items; for a Map, **Add Entry** adds a key and its value. |
| Remove Field | Deletes the selected field. |

**Save Setup**

| Setting | Description |
| --- | --- |
| Use As Project Default | Makes this the project's active Save Game and adds its fields to NodeGraphs. The button then reads **Project Default**. |
| Default Slot | The slot used when a node names none. Shown once this is the project default. |
| Default Profile | Keeps each player's saves together. Shown once this is the project default. |

**Advanced**

| Setting | Description |
| --- | --- |
| Data Definition | The Data Definition the fields come from, or **None** to edit them here. See [Fields from a Data Definition](#fields-from-a-data-definition). |
| Schema Version | Raise it for incompatible changes, then register a migration before **Load Game**. |
| Generated Type | Read-only text that shows the type built from the fields. |

## Notes

- Only the project default Save Game adds per-field **Get Save** and **Set Save** nodes, such as **Get Save Coins**, to **Add Node**. You can also pick it in **Project Settings > Save Games > Default Definition**.
- To save an actor's position and variables, add a [Save Game component](../components/save-game.md) to it.

## Related

- [Save Games](../scripting/save-games.md)
- [Data Definition](data-definition.md)
- [Load Game](../scripting/class/load-game.md)
- [Save Game node](../scripting/class/save-game.md)
- [New Game](../scripting/class/new-game.md)
