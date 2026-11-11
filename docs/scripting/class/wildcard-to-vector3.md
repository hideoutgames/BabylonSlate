---
node: wildcard.to_vec3
---

# Wildcard To Vector3

Converts an Any value to a Vector3 and reports whether it worked.

## Inputs

| Pin | Type | Description |
| --- | --- | --- |
| In | Exec |  |
| In | Any | The value to convert. Accepts any type. |
| Fallback | Vector3 | Used for **Value** when the conversion fails. Defaults to (0, 0, 0). |

## Outputs

| Pin | Type | Description |
| --- | --- | --- |
| Out | Exec |  |
| Success | Boolean | True when the value has the requested type. |
| Value | Vector3 | The converted value, or **Fallback** when the conversion fails. |

## Notes

- Succeeds only when the value is a Vector3.
- When the value has a different type, **Success** is false and **Value** is **Fallback**.
