# Structure

A user-defined record of typed fields, such as a weapon's name, damage and range.

## Create

In the **Content Browser**, choose **New Asset > Scripting > Structure**.

## Editor

Double-tap a Structure to open it.

- **Members**: one row per field, with its name and type. Tap a row to select it; double-tap its name (or press F2) to rename it. Tap **Add field** (**+**) to add one, and the remove button to delete the selected one. The arrows move a field up or down.
- **Inspector**: the selected field's settings.

## Settings

| Setting | Description |
| --- | --- |
| Name | The field's name. |
| Type | The kind of value the field holds. See [Pin Types](../scripting/pin-types.md). |
| Enum Type, Record Type | For an **Enum** or **Structure / Data Definition** field: which Enum, Structure or Data Definition it uses. |
| Loading | For Asset and Class fields. **Soft (Load On Demand)** loads on first use; **Hard (Load With Owner)** loads with the object that holds it. |
| Default | The field's starting value. The editor depends on the type. |

## Notes

- Choose **Structure / Data Definition** as a variable or pin type, then pick the Structure under **Record Type**.
- For each Structure, **Add Node** lists a **Make** node with one input per field and a **Break** node with one output per field.
- Renaming or removing a field removes the wires to that field's pin on Make and Break nodes.

## Related

- [Structures and Enums](../scripting/structures-and-enums.md)
- [Make Structure](../scripting/class/make-structure.md)
- [Break Structure](../scripting/class/break-structure.md)
- [Enum](enum.md)
- [Data Definition](data-definition.md)
