# Skybox

A cubemap sky that surrounds the scene.

## Add it

Select an actor, then choose **Add Component > Rendering > Skybox**. You can also place a ready-made actor from **Place Actors > Environment > Skybox**. New 3D scenes already contain a locked Skybox actor that shows the engine's default sky.

## Settings

| Setting | Description |
| --- | --- |
| Size | Edge length of the sky cube, 1 to 10,000. Default 1000. |
| Positive X, Positive Y, Positive Z | The Texture for each positive cube face. Empty shows the default sky's face. |
| Negative X, Negative Y, Negative Z | The Texture for each negative cube face. Empty shows the default sky's face. |

## Notes

- World scenes only.
- The Skybox follows its actor's position, rotation and scale. Rotate the actor to turn the sky.
- It always draws behind the scene, even beyond the camera's Far Clip.
- It cannot be picked in the viewport. Select it in the **Outliner**. The default Skybox is locked, so unlock it first.
- It is a backdrop only. It does not light the scene, cast shadows or receive fog.
- To cut six face Textures from a single image, use [Skybox Creator](../assets/skybox-creator.md).

## Related

- [Sky and fog](../graphics/sky-and-fog.md)
- [Lighting](../graphics/lighting.md#environment-lighting)
- [Texture](../assets/texture.md)
