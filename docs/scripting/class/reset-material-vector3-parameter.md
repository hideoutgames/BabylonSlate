---
node: material.resetVector3Parameter
---

# Reset Material Vector3 Parameter

Restores a Vector3 parameter on a Material Object to its original value.

## Inputs

| Pin | Type | Description |
| --- | --- | --- |
| Exec | Exec |  |
| Material | MaterialObject Reference |  |
| Name | String | The parameter name, as authored in the Material. In a Class whose mesh components have Materials, pick it from their parameters of this type. |

## Outputs

| Pin | Type |
| --- | --- |
| Then | Exec |
| Success | Boolean |

## Notes

- The original value is the one authored in the Material, or the one saved on a post-process pass.
- **Success** is false when the parameter does not exist, is not a Vector3, or the Material Object is no longer valid.
