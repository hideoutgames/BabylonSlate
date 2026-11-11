---
node: wildcard.to_vec2
---

# Wildcard To Vector2

Converts an Any value to a Vector2 and reports whether it worked.

## Inputs

| Pin | Type | Description |
| --- | --- | --- |
| In | Exec |  |
| In | Any | The value to convert. Accepts any type. |
| Fallback | Vector2 | Used for **Value** when the conversion fails. Defaults to (0, 0). |

## Outputs

| Pin | Type | Description |
| --- | --- | --- |
| Out | Exec |  |
| Success | Boolean | True when the value has the requested type. |
| Value | Vector2 | The converted value, or **Fallback** when the conversion fails. |

## Notes

- Succeeds only when the value is a Vector2.
- When the value has a different type, **Success** is false and **Value** is **Fallback**.
