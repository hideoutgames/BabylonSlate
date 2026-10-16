---
node: wildcard.to_quat
---

# Wildcard To quat

Converts an Any value to a Quaternion and reports whether it worked.

## Inputs

| Pin | Type | Description |
| --- | --- | --- |
| In | Exec |  |
| In | Any | The value to convert. Accepts any type. |
| Fallback | Quaternion | Used for **Value** when the conversion fails. Defaults to the identity quaternion (no rotation). |

## Outputs

| Pin | Type | Description |
| --- | --- | --- |
| Out | Exec |  |
| Success | Boolean | True when the value has the requested type. |
| Value | Quaternion | The converted value, or **Fallback** when the conversion fails. |

## Notes

- Succeeds only when the value is a Quaternion.
- When the value has a different type, **Success** is false and **Value** is **Fallback**.
