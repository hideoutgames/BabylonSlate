# Enum

A fixed list of named options, each with a value from 0 to 255, used by pins and variables.

## Create

In the **Content Browser**, choose **New Asset > Scripting > Enum**.

## Editor

Double-tap an Enum to open it.

- **Members**: one row per option, with its name and value. Tap a row to select it; double-tap its name (or press F2) to rename it. Values are whole numbers from 0 to 255; a decimal rounds to the nearest one and a value outside the range moves to the nearest end. Tap **Add member** (**+**) to add one, and the remove button to delete the selected one. The arrows move a member up or down.
- **Inspector**: the selected member's settings.

## Settings

| Setting | Description |
| --- | --- |
| Name | The member's name. |
| Value | The member's whole number, from 0 to 255. Older values outside this range load as 0 or 255. |

## Notes

- Choose **Enum** as a variable or pin type, then pick the Enum under **Enum Type**.
- For each Enum, **Add Node** lists nodes named after it. For an Enum called Weapon: **Make Weapon**, **Equal Weapon**, **Not Equal Weapon**, **Weapon to String** and **Switch on Weapon**, plus **Select**.
- When you remove a member, Switch and Select nodes lose that member's pin and its wires.

## Related

- [Structures and Enums](../scripting/structures-and-enums.md)
- [Make Enum](../scripting/class/make-enum.md)
- [Switch on Enum](../scripting/class/switch-on-enum.md)
- [Structure](structure.md)
