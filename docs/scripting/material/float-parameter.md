---
node: param.float
---

# Float Parameter

Outputs a named Float that can be changed at runtime or overridden per Material Instance.

## Outputs

| Pin | Type |
| --- | --- |
| Out | Float |

## Settings

| Setting | Description |
| --- | --- |
| Parameter Name | The unique name used to set the parameter from a Node Graph or a Material Instance. |
| Per Instance | Lets each actor drawn with the material have its own value while still drawing together with the others. |
| Value | The default value. |

## Notes

- Set it from a Node Graph with **Set Material Float Parameter**.
- Names must be unique across all parameters in the material, whatever their type.
- With **Per Instance** on, an actor that changes only per-instance parameters keeps sharing the material, so many actors with different values still draw in one batch. Changing any other parameter on an actor gives that actor its own copy of the material.
- **Per Instance** applies to the material's own parameters, not to parameters inside a Material Function.
