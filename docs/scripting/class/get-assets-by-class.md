# Get Assets By Class

Lists the Class assets of a chosen Class, and optionally of Classes that inherit from it.

## Inputs

| Pin | Type |
| --- | --- |
| Class | Object Class |
| Include Subclasses | Boolean |
| Folder | String |
| Recursive | Boolean |

## Outputs

| Pin | Type | Description |
| --- | --- | --- |
| Assets | Array of AssetData |  |
| Classes | Array of Object Class | The Class values of the listed assets, in the same order, typed as the selected Class. |

## Notes

- Nothing is loaded; the lookup uses the catalog only.
- With **Include Subclasses** on, Classes that inherit from **Class** are listed too.
- **Classes** holds the same Classes as Class values, so a Class that inherits from Actor can feed [**Spawn Actor**](spawn-actor.md).
