---
node: scalability.setResolutionQuality
---

# Set Resolution Quality

Sets render scale, dynamic resolution limits and the target frame rate.

## Inputs

| Pin | Type | Description |
| --- | --- | --- |
| Exec | Exec |  |
| Settings | ResolutionQuality | Every field of the structure is applied. |

## Outputs

| Pin | Type | Description |
| --- | --- | --- |
| Then | Exec |  |
| Result | ScalabilityResult | Outcome of the request. It stays pending until the renderer confirms the change. |

## Notes

- With dynamic resolution on, the renderer lowers the scale towards the minimum when the game cannot hold the target frame rate.
- Applies to the current session only and does not change project settings.
