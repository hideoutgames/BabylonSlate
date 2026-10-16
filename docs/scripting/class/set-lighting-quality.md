---
node: scalability.setLightingQuality
---

# Set Lighting Quality

Chooses automatic or manual limits on how many local lights are drawn.

## Inputs

| Pin | Type | Description |
| --- | --- | --- |
| Exec | Exec |  |
| Settings | LightingQuality | Every field of the structure is applied. |

## Outputs

| Pin | Type | Description |
| --- | --- | --- |
| Then | Exec |  |
| Result | ScalabilityResult | Outcome of the request. It stays pending until the renderer confirms the change. |

## Notes

- Automatic follows the current quality tier. Manual uses the maximum number of local lights you set.
- Applies to the current session only and does not change project settings.
