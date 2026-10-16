---
node: bt.task.playSound
---

# Play Sound

Plays an Audio asset from the actor and succeeds.

## Settings

| Setting | Default | Description |
| --- | --- | --- |
| Audio |  | The Audio asset to play. |
| Volume | 1 | Playback volume from 0 (silent) to 1 (full). |

## Notes

- The task succeeds as soon as playback starts, without waiting for the sound to finish.
- It fails if no Audio asset is chosen or the asset is missing.
- The Audio asset's own Loop setting applies.
