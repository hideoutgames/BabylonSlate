---
node: flow.event.richTextDisappearFinished
---

# Event On Disappear Finished

Runs when **Play Reverse** has hidden every letter of a 2D Rich Text.

## Outputs

| Pin | Type |
| --- | --- |
| Out | Exec |

## Notes

- Runs once each time **Play Reverse** brings the text to fully hidden, including when it hides at once because **Appear Modes** is Off.
- Does not run when the text was already hidden, and does not run for a text that starts **Hidden**.
- Belongs to a **2D Rich Text** component. See [2D Rich Text](../../components/2d-rich-text.md#reveal-events).
