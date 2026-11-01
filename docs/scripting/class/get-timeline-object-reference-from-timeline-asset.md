---
node: timeline.fromAsset
---

# Get Timeline Object Reference From Timeline Asset

Returns the Timeline object of a [Timeline](../../assets/timeline.md) asset, to reach its clips and listen to their events from any script.

## Inputs

| Pin | Type | Description |
| --- | --- | --- |
| Timeline Asset | Timeline Asset | The Timeline asset. |

## Outputs

| Pin | Type | Description |
| --- | --- | --- |
| Timeline | Timeline Reference | Valid for the whole session, whether or not the scenes holding its clips are loaded. |

## Notes

- There is one Timeline object per asset for the session, so you can keep it in a variable.
- The output is typed to the asset you pick on the pin, or to the default of a variable of this Class wired into it. Dragging from it then offers [Get Timeline Asset Clip](get-timeline-asset-clip.md) for each clip and Bind for each re-fired event, such as **On Door Open (Intro)**.
- Anything else wired into **Timeline Asset** gives a plain Timeline, which offers only [Get Loaded Timeline Clips](get-loaded-timeline-clips.md). **Cast to** the asset narrows it.
- A Timeline asset that holds no clips shows a warning.
