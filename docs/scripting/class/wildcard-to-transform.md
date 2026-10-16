# Wildcard To transform

Converts an Any value to a Transform and reports whether it worked.

## Inputs

| Pin | Type | Description |
| --- | --- | --- |
| In | Exec |  |
| In | Any | The value to convert. Accepts any type. |
| Fallback | Transform | Used for **Value** when the conversion fails. Defaults to the identity transform (no movement, rotation or scaling). |

## Outputs

| Pin | Type | Description |
| --- | --- | --- |
| Out | Exec |  |
| Success | Boolean | True when the value has the requested type. |
| Value | Transform | The converted value, or **Fallback** when the conversion fails. |

## Notes

- Succeeds only when the value is a Transform.
- When the value has a different type, **Success** is false and **Value** is **Fallback**.
