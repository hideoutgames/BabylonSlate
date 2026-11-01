---
node: timeline.getClip
---

# Get Timeline Asset Clip

Returns one of a Timeline asset's clips through its Timeline, to play and control from any script.

## Inputs

| Pin | Type | Description |
| --- | --- | --- |
| Target | Timeline Reference | The Timeline, from [Get Timeline Object Reference From Timeline Asset](get-timeline-object-reference-from-timeline-asset.md). |

## Outputs

| Pin | Type | Description |
| --- | --- | --- |
| Timeline Clip | Timeline Clip Reference | None while the clip's Scene or Scene Layer is not loaded. |

## Notes

- Add Node lists one for each clip the asset holds, titled with its name, such as **Get Intro Timeline Clip**, when you drag from a Timeline typed to that asset.
- When several copies of a Scene Layer are loaded, it returns the clip of the first one created. The main Scene's clip comes before any Scene Layer's.
- Its output is typed to that clip, so dragging from it also offers the [Timeline Clip nodes](../../scenes/timeline.md#control-a-clip-from-a-script) and Bind for the clip's own events.
- Renaming the clip renames the node. If the clip is deleted or unbound from the asset, the node shows an error until you remove it.
