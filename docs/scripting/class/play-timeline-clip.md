---
node: timelineClip.play
---

# Play Timeline Clip

Plays a Timeline Clip forwards from where it is.

## Inputs

| Pin | Type | Description |
| --- | --- | --- |
| In | Exec |  |
| Target | Timeline Clip Reference | The clip, from [Get Scene Timeline Clip](get-scene-timeline-clip.md). |

## Outputs

| Pin | Type |
| --- | --- |
| Out | Exec |

## Notes

- A **Once** clip at its end starts over from the start.
- Nothing happens while the clip's Scene or Scene Layer cannot run, for example while the game is paused.
- See [Play clips in the game](../../scenes/timeline.md#play-clips-in-the-game).
