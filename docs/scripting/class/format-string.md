---
node: string.format
---

::: v-pre
# Format String

Builds text from a template, replacing each placeholder with a wired value.

## Inputs

| Pin | Type | Description |
| --- | --- | --- |
| Format | String | The template text. The default is `{input}`. |
| Input | Any | Value for the `{input}` placeholder. Values are converted to text in the same way as the To String nodes. |

## Outputs

| Pin | Type |
| --- | --- |
| Out | String |

## Notes

- Each different name in braces, such as `{score}`, adds an input pin with that name.
- Write `{{` for a literal opening brace and `}}` for a literal closing brace.
- When **Format** is wired, no placeholder pins appear and the wired text is used as it is.

:::
