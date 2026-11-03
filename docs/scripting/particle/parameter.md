---
node: input.parameter
---

# Parameter

Returns a graph parameter: a value that gameplay can change while the emitter runs.

## Outputs

| Pin | Type |
| --- | --- |
| Value | Any |

## Notes

- Its type is the parameter's: Float, Vector 2, Vector 3 or Color.
- Gameplay sets the value by the parameter's name for every emitter of a Particle System that reads it, with [Set Particle Float Parameter](../class/set-particle-float-parameter.md) and its Vector and Color versions. Without a value set, the Particle System's default applies, then the parameter's own default.
- Changing a parameter's name or default keeps the running emitter; its particles take the new value.
- If its parameter is deleted, the node shows an error until you delete it.
