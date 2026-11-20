---
node: scene-layer.registerPostProcess
---

# Register Scene Layer Post-Processing

Adds a post-process Material to the passes every Scene Layer shares and returns the new pass's Material Object.

## Inputs

| Pin | Type |
| --- | --- |
| In | Exec |
| Material | Material Asset |

## Outputs

| Pin | Type | Description |
| --- | --- | --- |
| Out | Exec |  |
| Pass | MaterialObject Reference | The new pass as a Material Object. Use it with the Material Parameter nodes. None when nothing was added. |

## Notes

- The Material must use the Post Process domain. Any other Material is reported as an error when the graph is checked.
- The pass is added after the existing ones, which start as **Project Settings > Rendering > Scene Layer Post-Processing** sets them. It applies to all layers together: every layer draws into one image, the passes run over it, and the result is blended over the world. See [Scene Layer post-processing](../../scenes/scene-layers.md#scene-layer-post-processing).
- The pass lasts until the game stops or [Unregister Scene Layer Post-Processing](unregister-scene-layer-post-processing.md) removes it, through scene changes and while no layer is shown.
- To animate the pass, keep **Pass** in a variable and use the Material Parameter nodes, such as [Set Material Float Parameter](set-material-float-parameter.md). It stops working once the pass is removed.
- To add a pass to the current Scene instead, use [Register Scene Post-Processing](register-scene-post-processing.md).
