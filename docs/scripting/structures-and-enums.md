# Structures and Enums

A Structure groups related values into one record, such as a weapon's name, damage and range. An Enum is a fixed list of named options, such as Idle, Walking and Running.

## Create an Enum

1. In the **Content Browser**, choose **New Asset > Scripting > Enum**.
2. Open it. In **Members**, tap **Add member** (**+**) for each option.
3. Select a member to edit its **Name** and **Value** (a whole number) in the **Inspector**. Use the arrows to reorder members.

## Use an Enum in graphs

Choose **Enum** as a variable or pin type, then pick the Enum under **Enum Type**. For each Enum, **Add Node** lists:

| Node | What it does |
| --- | --- |
| **Make** *Name* | Returns one member, chosen on the node. See [Make Enum](class/make-enum.md). |
| **Equal** *Name*, **Not Equal** *Name* | Compares two values. See [Equal Enum](class/equal-enum.md) and [Not Equal Enum](class/not-equal-enum.md). |
| *Name* **to String** | Returns the member's name as text. See [Enum to String](class/enum-to-string.md). |
| **Switch on** *Name* | Runs one execution output per member, plus **Default**. See [Switch on Enum](class/switch-on-enum.md). |
| **Select** *Name* | Returns the value wired to the matching member. See [Select](class/select.md). |

Drag from an Enum pin to see these nodes first. When you remove a member, Switch and Select nodes lose that member's pin and its wires.

## Create a Structure

1. In the **Content Browser**, choose **New Asset > Scripting > Structure**.
2. Open it. In **Members**, tap **Add field** (**+**) for each value.
3. Select a field to set its **Name**, **Type** and default value in the **Inspector**. A field can itself be an Enum, a Structure or a Data Definition. Integer, Float and Vector fields also take a **Unit** (for example **Pixels**), shown after the value wherever the field is edited; the value is unchanged.

## Use a Structure in graphs

Choose **Structure / Data Definition** as a variable or pin type, then pick the Structure under **Record Type**. For each Structure, **Add Node** lists:

- **Make** *Name*, with one input per field. See [Make Structure](class/make-structure.md).
- **Break** *Name*, with one output per field.

A Structure variable's default is edited field by field in the **Inspector**. Renaming or removing a field removes the wires to that field's pin on Make and Break nodes.

## Built-in types

Haptic also provides Enums and Structures that are not assets but appear in the same pickers and **Add Node** lists, for example:

- Enums: **Collision Channel**, **Easing Curve**, **Key**, **Render Target Mode**, **Touch Phase** and **Touch Type**.
- Structures: **Hit Result** (returned by collision events and traces), **TagContainer**, **Save Game Info** and **Touch** (returned by the [touch nodes](../input/index.md#touch)).

Vectors, Rotator, Color and Transform have their own Make and Break nodes, such as [Make Transform](class/make-transform.md) and [Break Color](class/break-color.md).

For larger sets of typed records, such as every weapon in the game, use [Data Definitions and Data Trees](data.md).
