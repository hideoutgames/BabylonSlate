---
node: flow.event.textChanged
---

# Event On Text Changed

Runs when the text of a text display component changes.

## Outputs

| Pin | Type | Description |
| --- | --- | --- |
| Out | Exec |  |
| Text | String | The new text. |

## Notes

- Runs only when the text actually changes; setting the text from inside this event does not run it again.
- Belongs to **3D Text**, **2D Text** and **2D Rich Text** components.
- A **2D Text Input** control has its own text-changed event.
