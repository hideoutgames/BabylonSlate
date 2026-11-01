---
node: timelineClip.setPosition
---

# Set Timeline Clip Position

Moves a Timeline Clip to a time and applies its values there.

## Inputs

| Pin | Type | Description |
| --- | --- | --- |
| In | Exec |  |
| Target | Timeline Clip Reference | The clip, from [Get Scene Timeline Clip](get-scene-timeline-clip.md). |
| Time | Float | Seconds from the clip's start, kept within its **Length**. |
| Fire Events | Boolean | When on, the event keys between the old and the new time fire, in that direction. Off by default. |

## Outputs

| Pin | Type |
| --- | --- |
| Out | Exec |

## Notes

- A playing clip keeps playing from the new time.
- See [Play clips in the game](../../scenes/timeline.md#play-clips-in-the-game).
