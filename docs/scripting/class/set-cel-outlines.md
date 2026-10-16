---
node: scalability.setCelOutlines
---

# Set CEL Outlines

Turns global CEL outlines on or off and sets their colour and width.

## Inputs

| Pin | Type |
| --- | --- |
| Exec | Exec |
| Enabled | Boolean |
| Color | Color |
| Width | Float |

## Outputs

| Pin | Type | Description |
| --- | --- | --- |
| Then | Exec |  |
| Result | ScalabilityResult | Outcome of the request. It stays pending until the renderer confirms the change. |

## Notes

- Outline styles set on components and the outline for editor selection are not affected.
- Applies to the current session only and does not change project settings.
