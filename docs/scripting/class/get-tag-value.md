---
node: richText.getTagValue
---

# Get Tag Value

Returns the value a Letter Effect's `[fx]` tag gives one of its keywords.

## Inputs

| Pin | Type |
| --- | --- |
| Key | String |

## Outputs

| Pin | Type | Description |
| --- | --- | --- |
| Value | String | The keyword's value as written in the tag, such as `2` for `speed=2`. Empty when the tag does not set it. |

## Notes

- Only in graphs of Classes whose parent is **RichText2DLetterEffect**.
- Reads the tag of the letters that [Event On Update Letters](event-on-update-letters.md) is running for. Anywhere else it returns an empty string.
- Key is not case-sensitive. It must be one of the keywords the Class lists in its **Get Keys** function; any other key returns an empty string.
- The value is always text. Use a node such as [Parse Float](parse-float.md) to turn it into a number.
- See [Tag keywords](../../components/2d-rich-text.md#tag-keywords).
