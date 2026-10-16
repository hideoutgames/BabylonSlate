---
node: sceneStreaming.isSceneLoaded
---

# Is Scene Loaded

Returns true once all actors and render resources of a streamed Scene are ready.

## Inputs

| Pin | Type |
| --- | --- |
| Target | SceneStreamingActor Reference |

## Outputs

| Pin | Type |
| --- | --- |
| Out | Boolean |

## Notes

- False while the Scene is loading, unloading or not loaded.
