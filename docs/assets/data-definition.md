# Data Definition

The fields, defaults and validation rules for the entries of a Data Tree, such as a weapon's damage, price and icon.

## Create

In the **Content Browser**, choose **New Asset > Data > Data Definition**.

## Editor

Double-tap a Data Definition to open it.

- **Fields**: one row per field, with its name and type. Use **Add Field** to add one and select a row to edit it.
- **Inspector**: the settings of the selected field. If it is closed, reopen it from the **Windows** menu.

## Settings

| Setting | Description |
| --- | --- |
| Name | The field's name. |
| Type | The kind of value the field holds, such as **Bool**, **Int**, **Float**, **String**, **Tag**, **Vector 3**, **Color**, **Class**, **Asset** or **Enum**. See [Pin Types](../scripting/pin-types.md). A field can also be another **Data Definition**. |
| Container | **Single**, **Array** or **Map**. A Map also asks for a **Key Type**. |
| Class Type, Enum Type, Data Definition Type, Asset Type | Narrows a class, enum, record or asset field. **Asset Type** defaults to **Any Asset**. |
| Loading | For Asset and Class fields. **Soft (Load On Demand)** or **Hard (Load With Owner)**. |
| Default Value | The value new entries start with. |
| Category | A free-text category for the field. |
| Description | A free-text note about the field. |
| Required | An empty value is reported as a validation issue. |
| Limit Minimum, Minimum | For single Int and Float fields. Turn on **Limit Minimum**, then set the lowest allowed value. |
| Limit Maximum, Maximum | The same for the highest allowed value. |

## Notes

- New entries start from the Definition's defaults, then keep their own values. When a Definition changes, an entry that uses it shows **Definition Changed** with **Review Changes**.
- A Data Definition also works as a variable type, so scripts can build and break records with **Make** and **Break** nodes.

## Related

- [Data Definitions and Data Trees](../scripting/data.md)
- [Data Tree](data-tree.md)
- [Structure](structure.md)
- [Read Data Entry](../scripting/class/read-data-entry.md)
