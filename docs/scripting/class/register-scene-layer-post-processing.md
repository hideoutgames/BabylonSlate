---
node: scene-layer.registerPostProcess
---

# Register Scene Layer Post-Processing

Adds a post-process Material to the effects applied to a Scene Layer and returns the new pass's Material Object.

## Inputs

| Pin | Type |
| --- | --- |
| In | Exec |
| Layer | SceneLayer Reference |
| Material | Material Asset |

## Outputs

| Pin | Type | Description |
| --- | --- | --- |
| Out | Exec |  |
| Pass | MaterialObject Reference | The new pass as a Material Object. Use it with the Material Parameter nodes. None when nothing was added. |

## Notes

- The Material must use the Post Process domain. Any other Material is reported as an error when the graph is checked.
- The effect is added after the layer's existing ones.
- To animate the pass, keep **Pass** in a variable and use the Material Parameter nodes, such as [Set Material Float Parameter](set-material-float-parameter.md). It stops working once the pass is removed.
- To add a pass to the current Scene instead, use [Register Scene Post-Processing](register-scene-post-processing.md).
