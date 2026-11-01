---
node: timelineClip.setPlayRate
---

# Set Timeline Clip Play Rate

Sets how fast a Timeline Clip plays.

## Inputs

| Pin | Type | Description |
| --- | --- | --- |
| In | Exec |  |
| Target | Timeline Clip Reference | The clip, from [Get Scene Timeline Clip](get-scene-timeline-clip.md). |
| Play Rate | Float | 1 plays at the authored speed, 2 twice as fast, 0 holds still. |

## Outputs

| Pin | Type |
| --- | --- |
| Out | Exec |

## Notes

- A negative rate counts as 0. Use **Reverse Timeline Clip** to play backwards.
- It changes this copy of the clip only; the clip's **Play Rate** in the editor stays as it is.
- See [Play clips in the game](../../scenes/timeline.md#play-clips-in-the-game).
