---
node: flow.event.uiSelectionChanged
---

# Event On Selection Changed

Runs when the selected option of a 2D Dropdown changes.

## Outputs

| Pin | Type | Description |
| --- | --- | --- |
| Out | Exec |  |
| Index | Integer | Position of the chosen option, starting at 0. It is -1 when nothing is selected. |
| Value | String | Text of the chosen option. It is empty when nothing is selected. |

## Notes

- Also runs when a script calls **Set Selected Index**.
- Belongs to a **2D Dropdown** component.
