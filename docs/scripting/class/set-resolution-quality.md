---
node: scalability.setResolutionQuality
---

# Set Resolution Quality

Sets the render scale of the 3D world.

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

- **Scale** runs from 0.25 to 1, where 1 renders at full resolution. The scale stays fixed until the next change.
- Scales the world only. [Scene Layers](../../scenes/scene-layers.md) keep full resolution.
- Applies to the current session only and does not change project settings.
