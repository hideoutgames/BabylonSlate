# Wildcard To actorRef:Actor

Converts an Any value to an Actor Reference and reports whether it worked.

## Inputs

| Pin | Type | Description |
| --- | --- | --- |
| In | Exec |  |
| In | Any | The value to convert. Accepts any type. |
| Fallback | Actor Reference | Used for **Value** when the conversion fails. Defaults to an empty reference. |

## Outputs

| Pin | Type | Description |
| --- | --- | --- |
| Out | Exec |  |
| Success | Boolean | True when the value has the requested type. |
| Value | Actor Reference | The converted value, or **Fallback** when the conversion fails. |

## Notes

- Succeeds only for a reference to an actor. A reference to another kind of object fails.
- When the value has a different type, **Success** is false and **Value** is **Fallback**.
