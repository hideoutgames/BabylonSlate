---
node: wildcard.to_int
---

# Wildcard To int

Converts an Any value to an Integer and reports whether it worked.

## Inputs

| Pin | Type | Description |
| --- | --- | --- |
| In | Exec |  |
| In | Any | The value to convert. Accepts any type. |
| Fallback | Integer | Used for **Value** when the conversion fails. Defaults to 0. |

## Outputs

| Pin | Type | Description |
| --- | --- | --- |
| Out | Exec |  |
| Success | Boolean | True when the value has the requested type. |
| Value | Integer | The converted value, or **Fallback** when the conversion fails. |

## Notes

- Succeeds only when the value is an Integer. To convert a Float, use [**Float To Int**](float-to-int.md).
- When the value has a different type, **Success** is false and **Value** is **Fallback**.
