# Models

Models are imported 3D meshes. Importing one can also create its Materials, Textures, a Skeleton and one Animation per clip. Haptic generates simpler levels of detail for distant models automatically.

## Import a model

Import `.glb` or `.gltf` files, or `.fbx`, `.obj` and `.stl` files, which are converted on import. See [Importing](../editor/importing.md) for import settings.

| Created asset | When |
| --- | --- |
| [Model](../assets/model.md) | Always. |
| [Material](../assets/material.md) and [Texture](../assets/texture.md) assets | For the file's materials and images. |
| [Skeleton](../assets/skeleton.md) | When the model is rigged with a skin, or built from parented mesh parts. |
| [Animation](../assets/animation.md) | One per animation clip in the file. |

## Place a model

- Drag a Model from **Place Actors > Models**, or add a [Mesh](../components/mesh.md) component and pick the Model in **Asset**.
- Without an **Asset**, a Mesh component draws a primitive chosen in **Mesh Kind**.

## Materials

A Model has one material slot per material in the file.

- In the Model's editor, each slot shows its Material. **Default** keeps the material from the file.
- On a Mesh component, **Material** replaces every slot for that one actor. Choose **Model Materials** to go back to the Model's slots, or **None** for the engine's grey checker.
- Meshes with no Material draw a grey checker, so missing materials are easy to spot.

When the file uses material features a Haptic Material cannot represent, the Model keeps the original material, and the imported Material asset says so.

See [Materials](materials.md) to edit imported Materials or make your own.

## Skeletons and animation clips

- A **Skeleton** shows the model's bones.
- An **Animation** previews one clip on its model. Turn on **Show Bones** to see the bones instead of the mesh.
- To reuse clips on another character, select Animation assets in the **Content Browser**, choose **Retarget…** and pick the target Skeleton.

To play clips in a game, use an [Animation Graph](../assets/animation-graph.md) with the [Animation Graph](../components/animation-graph.md) component. Bone sockets are covered by [Attach To Bone](../scripting/class/attach-to-bone.md).

## Automatic LOD

Haptic simplifies eligible meshes when a model loads and switches to simpler versions as the model gets smaller on screen.

- Turn it on or off per Model with **Auto LOD** under **Level Of Detail** in the Model's editor. It is on by default.
- Eligible meshes have at least 1024 triangles. Each mesh gets up to three simpler levels.
- Levels take over when the model's bounds shrink below 1/2, 1/4 and 1/8 of the view height. **LOD Distance Scale** moves these switch points.

Project-wide settings are in the **Geometry** group of **Project Settings > Rendering > Scalability**:

| Setting | Low | Medium | High | Ultra |
| --- | --- | --- | --- | --- |
| **Auto LOD** | On | On | On | On |
| **LOD Distance Scale** | 0.5 | 1 | 1.5 | 2 |

Higher LOD Distance Scale values keep full detail farther away (range 0.25 to 4). Turning project Auto LOD off draws full detail everywhere.

Limits:

- LOD reduces triangles, not draw calls.
- Levels switch without a cross-fade.
- Model previews, thumbnails and foliage always use full detail.
- Levels are generated each time the game loads; they are not saved in the project or export.

[Set Geometry Quality](../scripting/class/set-geometry-quality.md) changes these settings for the session.
