---
node: timeline.getLoadedClips
---

# Get Loaded Timeline Clips

Returns every loaded clip of a Timeline asset.

## Inputs

| Pin | Type | Description |
| --- | --- | --- |
| Target | Timeline Reference | The Timeline, from [Get Timeline Object Reference From Timeline Asset](get-timeline-object-reference-from-timeline-asset.md). |

## Outputs

| Pin | Type |
| --- | --- |
| Timeline Clips | Array of Timeline Clip Reference |

## Notes

- The main Scene's clips come first, then each loaded Scene Layer copy's, in the order the copies were created. A Scene Layer loaded twice adds its clip twice.
- Clips of Scenes and Scene Layers that are not loaded are left out.
