---
node: timelineClip.setLoopMode
---

# Set Timeline Clip Loop Mode

Sets whether a Timeline Clip stops at its end, starts over or turns around.

## Inputs

| Pin | Type | Description |
| --- | --- | --- |
| In | Exec |  |
| Target | Timeline Clip Reference | The clip, from [Get Scene Timeline Clip](get-scene-timeline-clip.md). |
| Loop Mode | Timeline Loop Mode | **Once**, **Loop** or **Ping Pong**. |

## Outputs

| Pin | Type |
| --- | --- |
| Out | Exec |

## Notes

- It changes this copy of the clip only.
- See [Play clips in the game](../../scenes/timeline.md#play-clips-in-the-game).
