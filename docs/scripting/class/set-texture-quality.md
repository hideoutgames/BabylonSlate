---
node: scalability.setTextureQuality
---

# Set Texture Quality

Sets texture detail bias, anisotropic filtering and the texture memory budget.

## Inputs

| Pin | Type | Description |
| --- | --- | --- |
| Exec | Exec |  |
| Settings | TextureQuality | Every field of the structure is applied. |

## Outputs

| Pin | Type | Description |
| --- | --- | --- |
| Then | Exec |  |
| Result | ScalabilityResult | Outcome of the request. It stays pending until the renderer confirms the change. |

## Notes

- Detail bias runs from 0 to 8, anisotropy from 1 to 16, and the memory budget is in bytes.
- The device may allow less anisotropy than requested. Read the value in use from [**Get Effective Scalability**](get-effective-scalability.md).
