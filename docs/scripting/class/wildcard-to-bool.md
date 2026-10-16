---
node: wildcard.to_bool
---

# Wildcard To bool

Converts an Any value to a Boolean and reports whether it worked.

## Inputs

| Pin | Type | Description |
| --- | --- | --- |
| In | Exec |  |
| In | Any | The value to convert. Accepts any type. |
| Fallback | Boolean | Used for **Value** when the conversion fails. Defaults to false. |

## Outputs

| Pin | Type | Description |
| --- | --- | --- |
| Out | Exec |  |
| Success | Boolean | True when the value has the requested type. |
| Value | Boolean | The converted value, or **Fallback** when the conversion fails. |

## Notes

- Succeeds only when the value is a Boolean.
- When the value has a different type, **Success** is false and **Value** is **Fallback**.
