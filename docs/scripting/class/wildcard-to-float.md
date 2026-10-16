# Wildcard To float

Converts an Any value to a Float and reports whether it worked.

## Inputs

| Pin | Type | Description |
| --- | --- | --- |
| In | Exec |  |
| In | Any | The value to convert. Accepts any type. |
| Fallback | Float | Used for **Value** when the conversion fails. Defaults to 0. |

## Outputs

| Pin | Type | Description |
| --- | --- | --- |
| Out | Exec |  |
| Success | Boolean | True when the value has the requested type. |
| Value | Float | The converted value, or **Fallback** when the conversion fails. |

## Notes

- Succeeds for Float and Integer values.
- When the value has a different type, **Success** is false and **Value** is **Fallback**.
