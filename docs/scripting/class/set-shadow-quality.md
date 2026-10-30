---
node: scalability.setShadowQuality
---

# Set Shadow Quality

Sets shadow map size, filtering, distance and the limits for local-light shadows.

## Inputs

| Pin | Type | Description |
| --- | --- | --- |
| Exec | Exec |  |
| Settings | ShadowQuality | Every field of the structure is applied. |

## Outputs

| Pin | Type | Description |
| --- | --- | --- |
| Then | Exec |  |
| Result | ScalabilityResult | Outcome of the request. It stays pending until the renderer confirms the change. |

## Notes

- Changes that need new GPU resources are prepared at a frame boundary, so **Result** is pending at first.
- **Screen Shadows** in the structure sets **Screen-Space Shadows**: **Off**, **Low**, **Medium** or **High**. Turning them on or off recompiles lit Materials once; changing between Low, Medium and High does not.
- Applies to the current session only and does not change project settings.
