---
node: flow.event.richTextLetterAppear
---

# Event On Letter Appear

Runs on a Rich Text 2D Appear Mode for one letter of a 2D Rich Text as the text appears.

## Outputs

| Pin | Type | Description |
| --- | --- | --- |
| Out | Exec |  |
| Letter | RichText2DLetter Reference | The letter to change. |
| Alpha | Float | How far this letter has appeared, from 0 (not started) to 1 (fully shown), after the Appear Transition. |

## Notes

- Belongs to Classes whose parent is **RichText2DAppearMode**. Choose the Class in a 2D Rich Text's **Appear Modes**, where it is listed as its name followed by **(Custom)**.
- Runs once for every letter each time the reveal moves, forwards or backwards. It does not run while the reveal stands still.
- Each run starts with the letter at rest. Set the letter's **Offset**, **Scale**, **Rotation** and **Opacity** from Alpha; what you leave unset stays at rest.
- Back and Elastic transitions pass an Alpha a little below 0 or above 1.
- See [2D Rich Text](../../components/2d-rich-text.md#custom-appear-modes-and-effects).
