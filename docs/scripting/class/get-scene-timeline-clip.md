---
node: scene.getOwnedTimelineClip
---

# Get Scene Timeline Clip

Returns a Timeline Clip of this Scene or Scene Layer, to play and control from its script.

## Outputs

| Pin | Type |
| --- | --- |
| Timeline Clip | Timeline Clip Reference |

## Notes

- Only in a [Scene Script or Scene Layer Script](../scene-scripts.md). Add Node lists one for each clip, under **Scene Timeline Clips**, titled with its name, such as **Get Intro Timeline Clip**.
- Connect it to **Play**, **Pause**, **Stop** and the other Timeline Clip functions; see [Play clips in the game](../../scenes/timeline.md#play-clips-in-the-game).
- In a Scene Layer Script it returns the clip of this copy of the layer: each copy plays its own.
- Renaming the clip renames the node. If you delete the clip, the node shows an error until you remove it.
