# Wildcard To rotator

Converts an Any value to a Rotator and reports whether it worked.

## Inputs

| Pin | Type | Description |
| --- | --- | --- |
| In | Exec |  |
| In | Any | The value to convert. Accepts any type. |
| Fallback | Rotator | Used for **Value** when the conversion fails. Defaults to a zero rotation. |

## Outputs

| Pin | Type | Description |
| --- | --- | --- |
| Out | Exec |  |
| Success | Boolean | True when the value has the requested type. |
| Value | Rotator | The converted value, or **Fallback** when the conversion fails. |

## Notes

- Succeeds only when the value is a Rotator.
- When the value has a different type, **Success** is false and **Value** is **Fallback**.
