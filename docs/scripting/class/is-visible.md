---
node: component.isVisible
---

# Is Visible

True while the component draws, unless Set Visibility turned it off.

## Inputs

| Pin | Type |
| --- | --- |
| Target | Component Reference |

## Outputs

| Pin | Type |
| --- | --- |
| Visible | Boolean |

## Notes

- Reads what [Set Visibility](set-visibility.md) set; a component is visible until then.
- A component of a hidden actor still reports true: see [Is Actor Hidden In Game](is-actor-hidden-in-game.md).
