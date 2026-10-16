---
node: scalability.setRenderScale
---

# Set Render Scale

Sets a fixed render scale and turns off dynamic resolution.

## Inputs

| Pin | Type |
| --- | --- |
| Exec | Exec |
| Scale | Float |

## Outputs

| Pin | Type | Description |
| --- | --- | --- |
| Then | Exec |  |
| Result | ScalabilityResult | Outcome of the request. It stays pending until the renderer confirms the change. |

## Notes

- Scale runs from 0.25 to 1, where 1 renders at full resolution. Values outside that range are clamped.
- Applies to the current session only and does not change project settings.
