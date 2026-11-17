---
node: flow.event.richTextLetterShown
---

# Event On Letter Shown

Runs when a letter of a 2D Rich Text starts appearing.

## Outputs

| Pin | Type | Description |
| --- | --- | --- |
| Out | Exec |  |
| Index | Integer | Position of the letter in the text, starting at 0. Tags do not count, and an inline image counts as one. |
| Character | String | The letter itself. It is empty for an inline image. |

## Notes

- Runs once for each letter, in text order, at the moment it starts appearing: **Time Between Characters** times its Index into the reveal.
- Spaces and line breaks are not letters. Inline images are.
- Runs only while the text reveals forwards, from **Play On Start**, **Trigger Appear** or **Play**. **Play Reverse** never runs it.
- A reveal that continues from part-way runs it only for the letters that start at or after that point. **Trigger Appear** starts over.
- Does not run while **Appear Modes** is Off, because the text then shows at once.
- Runs after the reveal has moved for that tick, so the text's **Appear Progress** is already up to date.
- Belongs to a **2D Rich Text** component. See [2D Rich Text](../../components/2d-rich-text.md#reveal-events).
