---
node: scene-layer.getOwningSceneLayer
---

# Get Owning Scene Layer

Returns the Scene Layer an actor belongs to.

## Inputs

| Pin | Type | Description |
| --- | --- | --- |
| Actor | Actor Reference | Left unconnected the pin reads **Actor (Self)** and uses the actor running the graph. |

## Outputs

| Pin | Type |
| --- | --- |
| Layer | SceneLayer Reference |

## Notes

- Returns an empty reference for an actor in the world rather than on a Scene Layer, and once its layer has been removed.
- Use it in a **Scene Layer Actor** Class to reach its own layer, for example to move the [layer camera](../../scenes/scene-layers.md#move-the-layer-camera) from a layer that a scene shows.
- An **Actor** wired to an empty reference logs an error.
