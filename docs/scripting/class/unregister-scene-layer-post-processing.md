---
node: scene-layer.unregisterPostProcess
---

# Unregister Scene Layer Post-Processing

Removes a post-process Material from the passes every Scene Layer shares.

## Inputs

| Pin | Type |
| --- | --- |
| In | Exec |
| Material | Material Asset |

## Outputs

| Pin | Type |
| --- | --- |
| Out | Exec |

## Notes

- Removes the first pass that uses the Material, whether it came from **Project Settings > Rendering > Scene Layer Post-Processing** or from [Register Scene Layer Post-Processing](register-scene-layer-post-processing.md). The project setting itself is unchanged.
- If no pass uses the Material, an error is logged and play continues.
