# Skeleton

The bones of an imported model. Animations from the same file play on it.

## Import

Skeletons are not created from **New Asset**. Importing a rigged GLB or glTF model creates one, either from the model's skin or, when the model is built from parented mesh parts, from that hierarchy. See [Importing Assets](../editor/importing.md).

## Editor

Double-tap the asset to open it. The window has **Preview** and an **Inspector**. Both are read-only.

- **Preview** shows the owning model. If it cannot load the mesh, it shows **No Mesh**; open the [Model](model.md) instead.
- The **Inspector** lists the skeleton's bones.

## Settings

| Setting | Description |
| --- | --- |
| Kind | **Skin** for a rigged model, or **Hierarchy** for parented mesh parts. |
| Model | The Model the skeleton belongs to. |

The bone list is below these two rows.

## Use it

- To reuse [Animation](animation.md) clips on another character, select the clips in the **Content Browser**, choose **Retarget…** and pick the target Skeleton.
- To attach an actor to a bone, use [Attach To Bone](../scripting/class/attach-to-bone.md).

## Related

- [Models](../graphics/models.md)
- [Animation Graph](animation-graph.md)
