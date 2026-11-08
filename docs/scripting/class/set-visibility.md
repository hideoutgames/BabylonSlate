---
node: component.setVisibility
---

# Set Visibility

Shows or hides what the component draws. It keeps its place, so attached components follow it; Propagate To Children applies the same to them.

## Inputs

| Pin | Type | Description |
| --- | --- | --- |
| In | Exec |  |
| Target | Component Reference |  |
| New Visibility | Boolean | True shows what the component draws, false hides it. |
| Propagate To Children | Boolean | Also set every component attached below this one. |

## Outputs

| Pin | Type |
| --- | --- |
| Out | Exec |

## Notes

- A hidden component keeps its place, so components attached to it still follow it and stay visible unless **Propagate To Children** is on.
- Hiding a Light component turns its light off.
- Collision, sound and physics are unchanged.
- [Set Actor Hidden In Game](set-actor-hidden-in-game.md) hides a whole actor.
- If **Target** is empty when the node runs, nothing happens and an error is logged.
