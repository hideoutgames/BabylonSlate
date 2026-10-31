---
node: scalability.setEffects
---

# Set Rendering Effects

Sets the colour pipeline, tone mapping, exposure, bloom and vignette. Anti-aliasing is set with [Set Anti-Aliasing](set-anti-aliasing.md).

## Inputs

| Pin | Type | Description |
| --- | --- | --- |
| Exec | Exec |  |
| Settings | RenderEffects | Every field of the structure is applied. |

## Outputs

| Pin | Type | Description |
| --- | --- | --- |
| Then | Exec |  |
| Result | ScalabilityResult | Outcome of the request. It stays pending until the renderer confirms the change. |

## Notes

- Applies to the current session only and does not change project settings.
