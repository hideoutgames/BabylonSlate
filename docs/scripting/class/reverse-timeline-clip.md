---
node: timelineClip.reverse
---

# Reverse Timeline Clip

Plays a Timeline Clip backwards from where it is.

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

- A **Once** clip at its start starts over from the end.
- **Ping Pong** clips turn around at each end, as when playing forwards.
- See [Play clips in the game](../../scenes/timeline.md#play-clips-in-the-game).
