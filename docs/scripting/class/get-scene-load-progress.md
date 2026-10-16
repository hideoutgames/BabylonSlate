---
node: sceneStreaming.getSceneLoadProgress
---

# Get Scene Load Progress

Returns how far a streamed Scene has loaded, from 0 to 1.

## Inputs

| Pin | Type |
| --- | --- |
| Target | SceneStreamingActor Reference |

## Outputs

| Pin | Type |
| --- | --- |
| Out | Float |

## Notes

- 0 when the Scene is unloaded, and 1 only when it is fully loaded.
