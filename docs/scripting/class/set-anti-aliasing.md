---
node: scalability.setAntiAliasing
---

# Set Anti-Aliasing

Sets the edge anti-aliasing of the game's view for the current session: **MSAA 4x**, **MSAA 2x**, **FXAA** or **Off**.

## Inputs

| Pin | Type | Description |
| --- | --- | --- |
| Exec | Exec |  |
| Mode | Anti Aliasing Mode | `msaa4`, `msaa2`, `fxaa` or `off`. Default `msaa4`. |

## Outputs

| Pin | Type | Description |
| --- | --- | --- |
| Then | Exec |  |
| Result | ScalabilityResult | Outcome of the request. It stays pending until the renderer confirms the change. |

## Notes

- It sets the **Anti-Aliasing** setting of the **Post Processing** quality group; see [Anti-aliasing](../../graphics/post-processing.md#anti-aliasing).
- The renderer prepares the replacement before it confirms the request, so **Result** is pending at first, and the view keeps its last image for a moment.
- Applying a quality level (for example with [Set Scalability Preset](set-scalability-preset.md)) sets Anti-Aliasing to that level's mode.
