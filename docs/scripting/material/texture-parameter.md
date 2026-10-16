# Texture Parameter

Outputs a named texture that can be changed at runtime or overridden per Material Instance.

## Outputs

| Pin | Type |
| --- | --- |
| Out | Texture |

## Settings

| Setting | Description |
| --- | --- |
| Parameter Name | The unique name used to set the parameter from a Node Graph or a Material Instance. |
| Texture | The default texture asset. |

## Notes

- Connect it to the **Texture** input of [**Texture Sample**](texture-sample.md).
- Set it from a Node Graph with **Set Material Texture Parameter**.
