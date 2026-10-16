---
node: anim.rule.enterState
---

# Enter State

Decides whether the transition may enter its target state.

## Inputs

| Pin | Type | Description |
| --- | --- | --- |
| Value | Boolean | True lets the transition enter the target state. |

## Notes

- A transition fires only when both **Enter State** and [**Exit State**](exit-state.md) are true. An unconnected input counts as true.
- Found in transition rule graphs, which you open with **Open Rule** on a transition. It cannot be deleted.
