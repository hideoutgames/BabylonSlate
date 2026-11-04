---
node: scene.registerPostProcess
---

# Register Scene Post-Processing

Adds a post-process Material after the current Scene's post-process passes.

## Inputs

| Pin | Type | Description |
| --- | --- | --- |
| In | Exec |  |
| Material | Material Asset | A Material with the Post Process domain, or a Material Instance of one. |

## Outputs

| Pin | Type |
| --- | --- |
| Out | Exec |

## Notes

- The Material must use the Post Process domain. Any other Material is reported as an error when the graph is checked.
- The pass runs after the Scene's own **Post-Process Passes** and any passes registered before it. Registering the same Material again adds another pass.
- The pass lasts until the Scene changes; the next Scene starts with its own passes.
- [Unregister Scene Post-Processing](unregister-scene-post-processing.md) removes it. To add a pass to a Scene Layer instead, use [Register Scene Layer Post-Processing](register-scene-layer-post-processing.md).
