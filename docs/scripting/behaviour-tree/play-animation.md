---
node: bt.task.playAnimation
---

# Play Animation

Plays an Animation or Sprite Animation asset once, then succeeds.

## Settings

| Setting | Default | Description |
| --- | --- | --- |
| Clip Kind | animation | Whether to play an Animation or a Sprite Animation. Changing it clears **Clip Asset**. |
| Clip Asset |  | The clip to play. The list shows assets that match the **Clip Kind**. |

## Notes

- The task stays running for the length of the clip, and replaces the actor's Animation Graph output while it runs.
- It fails if no clip is chosen or the asset is missing.
