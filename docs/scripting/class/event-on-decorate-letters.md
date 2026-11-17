---
node: flow.event.richTextDecorateLetters
---

# Event On Decorate Letters

Runs every tick on a Rich Text 2D Decorator Effect with the letters inside its tag.

## Outputs

| Pin | Type | Description |
| --- | --- | --- |
| Out | Exec |  |
| Letters | Array of RichText2DLetter Reference | The letters inside the tag, in text order. |
| Delta Seconds | Float | Time since the last tick, in seconds. |
| Strength | Float | The tag's `strength` value, or 1 when the tag has none. |

## Notes

- Belongs to Classes whose parent is **RichText2DDecoratorEffect**. Apply the Class in a 2D Rich Text with `[fx=ClassName]…[/fx]`.
- Each tick starts from what the Appear Modes left on the letters. Set each letter's **Offset**, **Scale**, **Rotation** and **Opacity**.
- Keep running values, such as elapsed time, in variables of your Class. One object of the Class serves every tag of that Class in a text.
- Does not run while the game is paused, unless the text's actor ticks while paused.
- See [2D Rich Text](../../components/2d-rich-text.md#custom-appear-modes-and-effects).
