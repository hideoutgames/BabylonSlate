---
node: flow.event.richTextAppearFinished
---

# Event On Appear Finished

Runs when a 2D Rich Text finishes revealing forwards.

## Outputs

| Pin | Type |
| --- | --- |
| Out | Exec |

## Notes

- Runs once each time **Play On Start**, **Trigger Appear** or **Play** brings the text to fully revealed, including a reveal that finishes at once because **Appear Modes** is Off.
- Does not run when the text was already fully revealed, so **Play** on a revealed text does nothing, and does not run for a text that starts **Fully Revealed**.
- Runs in the tick the reveal finishes, after that tick's [Event On Letter Shown](event-on-letter-shown.md) runs. When **Play** finishes the reveal at once, it runs at the start of the next tick.
- Belongs to a **2D Rich Text** component. See [2D Rich Text](../../components/2d-rich-text.md#reveal-events).
