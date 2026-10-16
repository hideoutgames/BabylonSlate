---
node: wildcard.to_objectRef_BObject
---

# Wildcard To objectRef:BObject

Converts an Any value to an Object Reference and reports whether it worked.

## Inputs

| Pin | Type | Description |
| --- | --- | --- |
| In | Exec |  |
| In | Any | The value to convert. Accepts any type. |
| Fallback | Object Reference | Used for **Value** when the conversion fails. Defaults to an empty reference. |

## Outputs

| Pin | Type | Description |
| --- | --- | --- |
| Out | Exec |  |
| Success | Boolean | True when the value has the requested type. |
| Value | Object Reference | The converted value, or **Fallback** when the conversion fails. |

## Notes

- Succeeds for a reference to any object, including actors. An empty reference fails.
- When the value has a different type, **Success** is false and **Value** is **Fallback**.
