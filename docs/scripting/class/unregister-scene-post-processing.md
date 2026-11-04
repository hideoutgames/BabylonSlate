---
node: scene.unregisterPostProcess
---

# Unregister Scene Post-Processing

Removes the first of the current Scene's post-process passes that uses a Material.

## Inputs

| Pin | Type | Description |
| --- | --- | --- |
| In | Exec |  |
| Material | Material Asset | The post-process Material whose pass to remove. |

## Outputs

| Pin | Type |
| --- | --- |
| Out | Exec |

## Notes

- It removes passes added in the Scene's **Post-Process Passes** as well as passes added with [Register Scene Post-Processing](register-scene-post-processing.md).
- If no pass uses the Material, an error is logged and play continues.
- A Material reference from [Get Post Process Entry](get-post-process-entry.md) for the removed pass stops working.
