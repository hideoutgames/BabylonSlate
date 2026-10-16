# Wildcard To color

Converts an Any value to a Color and reports whether it worked.

## Inputs

| Pin | Type | Description |
| --- | --- | --- |
| In | Exec |  |
| In | Any | The value to convert. Accepts any type. |
| Fallback | Color | Used for **Value** when the conversion fails. Defaults to transparent black. |

## Outputs

| Pin | Type | Description |
| --- | --- | --- |
| Out | Exec |  |
| Success | Boolean | True when the value has the requested type. |
| Value | Color | The converted value, or **Fallback** when the conversion fails. |

## Notes

- Succeeds only when the value is a Color.
- When the value has a different type, **Success** is false and **Value** is **Fallback**.
