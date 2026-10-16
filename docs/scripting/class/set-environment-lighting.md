---
node: scalability.setEnvironmentLighting
---

# Set Environment Lighting

Changes image-based lighting: whether it is on, its intensity, rotation and CEL strength.

## Inputs

| Pin | Type | Description |
| --- | --- | --- |
| Exec | Exec |  |
| Settings | EnvironmentLighting | Every field of the structure is applied. |

## Outputs

| Pin | Type | Description |
| --- | --- | --- |
| Then | Exec |  |
| Result | ScalabilityResult | Outcome of the request. It stays pending until the renderer confirms the change. |

## Notes

- Rotation is in degrees around the vertical axis.
- The environment asset set in the Scene is not changed.
