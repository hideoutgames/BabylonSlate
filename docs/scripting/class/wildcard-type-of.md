---
node: wildcard.typeOf
---

# Wildcard Type Of

Returns the name of the type a value holds, such as int or vec3.

## Inputs

| Pin | Type | Description |
| --- | --- | --- |
| In | Any | The value to inspect. Accepts any type. |

## Outputs

| Pin | Type |
| --- | --- |
| Out | String |

## Notes

- Names include bool, int, float, string, vec2, vec3, vec4, rotator, quat, color and transform, and objectRef:Class or actorRef:Class for references.
- A value from a typed pin reports that pin's type. When the source is an Any pin, the name is worked out from the value, so a whole number reads as int.
