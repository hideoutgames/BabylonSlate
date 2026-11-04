---
node: scene.registerPostProcess
---

# Register Scene Post-Processing

Adds a post-process Material after the current Scene's post-process passes and returns the new pass's Material Object.

## Inputs

| Pin | Type | Description |
| --- | --- | --- |
| In | Exec |  |
| Material | Material Asset | A Material with the Post Process domain, or a Material Instance of one. |

## Outputs

| Pin | Type | Description |
| --- | --- | --- |
| Out | Exec |  |
| Pass | MaterialObject Reference | The new pass as a Material Object. Use it with the Material Parameter nodes. None when nothing was added. |

## Notes

- The Material must use the Post Process domain. Any other Material is reported as an error when the graph is checked.
- The pass runs after the Scene's own **Post-Process Passes** and any passes registered before it. Registering the same Material again adds another pass.
- The pass lasts until the Scene changes; the next Scene starts with its own passes.
- To animate the pass, keep **Pass** in a variable and use [Set Material Float Parameter](set-material-float-parameter.md), [Set Material Vector Parameter](set-material-vector-parameter.md) or [Set Material Color Parameter](set-material-color-parameter.md). It stops working once the pass is removed.
- [Unregister Scene Post-Processing](unregister-scene-post-processing.md) removes it. To add a pass to a Scene Layer instead, use [Register Scene Layer Post-Processing](register-scene-layer-post-processing.md).
