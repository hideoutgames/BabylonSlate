---
node: material.getPostProcessEntry
---

# Get Post Process Entry

Returns the Material Object of one post-process pass of a Scene, or of the passes every Scene Layer shares.

## Inputs

| Pin | Type | Description |
| --- | --- | --- |
| Owner | Object Reference | A Scene reference for that Scene's passes, or any Scene Layer reference for the Scene Layer passes. |
| Entry ID | String | The pass's Entry ID. |

## Outputs

| Pin | Type | Description |
| --- | --- | --- |
| Material | MaterialObject Reference | The pass as a Material Object. Use it with the Material Parameter nodes. |

## Notes

- Returns none when the Entry ID is empty or unknown, or the owner is not ready.
- Copy the Entry ID from the pass's Entry ID button in the **Post-Process Passes** list of the scene's **Inspector**, or in **Project Settings > Rendering > Scene Layer Post-Processing** (also shown in a Scene Layer's **Inspector**).
- A Scene Layer pass stays valid after the layer that named it is removed: every layer shares the passes, and they last until the game stops.
- Reordering passes keeps their Entry IDs, while removing or replacing a pass makes its Material Object invalid.
- A pass added while the game runs has no Entry ID to copy: use the **Pass** output of [Register Scene Post-Processing](register-scene-post-processing.md) or [Register Scene Layer Post-Processing](register-scene-layer-post-processing.md) instead.
