---
node: param.vec3
---

# Vector 3 Parameter

Outputs a named Vector 3 that can be changed at runtime or overridden per Material Instance.

## Outputs

| Pin | Type |
| --- | --- |
| Out | Vector 3 |

## Settings

| Setting | Description |
| --- | --- |
| Parameter Name | The unique name used to set the parameter from a Node Graph or a Material Instance. |
| Value | The default value. |

## Notes

- Set it from a Node Graph with **Set Material Vector Parameter**.
- Names must be unique across all parameters in the material, whatever their type.
- The value is used as authored, without colour conversion.
