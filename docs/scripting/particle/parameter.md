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

- Add one from **Add Node** under **Parameter**, or right-click a constant node and choose **Convert to Parameter**. **Convert to Constant** turns it back into a constant holding the parameter's default.
- Select it to edit the parameter's **Name**, **Type** and **Default** in the **Inspector**. Every node that reads the parameter shares them.
- Its type is the parameter's: Float, Vector 2, Vector 3 or Color.
- Gameplay sets the value by the parameter's name for every emitter of a Particle System that reads it, with [Set Particle Float Parameter](../class/set-particle-float-parameter.md) and its Vector and Color versions. Without a value set, the Particle System's default applies, then the parameter's own default.
- Changing a parameter's name or default keeps the running emitter; its particles take the new value.
- The parameter is removed when its last node is deleted or converted.
- A node whose parameter is missing shows an error until you pick another parameter, convert it or delete it.
