---
node: richText.getTagValue
---

# Get Tag Value

Returns the value the tag a Letter Effect or a Rich Text Decorator is running for gives one of its keywords.

## Inputs

| Pin | Type |
| --- | --- |
| Key | String |

## Outputs

| Pin | Type | Description |
| --- | --- | --- |
| Value | String | The keyword's value as written in the tag, such as `2` for `speed=2`. Empty when the tag does not set it. |

## Notes

- Only in graphs of Classes whose parent is **RichText2DLetterEffect** or **RichText2DDecorator**.
- In a Letter Effect, reads the `[fx]` tag of the letters that [Event On Update Letters](event-on-update-letters.md) is running for. Key must be one of the keywords the Class lists in its **Get Keys** function; any other key returns an empty string.
- In a Decorator, reads the tag that its **Decorate** function is turning into markup. Every keyword of the tag can be read.
- Anywhere else it returns an empty string. Key is not case-sensitive.
- The value is always text. Use a node such as [Parse Float](parse-float.md) to turn it into a number.
- See [Tag keywords](../../components/2d-rich-text.md#tag-keywords) and [Custom tags](../../components/2d-rich-text.md#custom-tags).
