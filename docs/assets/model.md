# Model

An imported 3D mesh, with a Material for each slot, simple collision shapes and automatic levels of detail.

## Import

Models are not created from **New Asset**. In the **Content Browser**, choose **Import** and pick a GLB, glTF, FBX, OBJ or STL file. Importing also creates the file's Materials and Textures, a [Skeleton](skeleton.md) for a rigged model, and one [Animation](animation.md) for each clip. See [Importing Assets](../editor/importing.md).

## Editor

Double-tap the asset to open it. The window has **Preview**, **Colliders** and an **Inspector**.

- **Preview** shows the mesh. A menu at the top right sets the shading to **PBR**, **Unlit** or **Wireframe**.
- **Show Collision** draws the model's colliders. With a collider selected, **Move**, **Rotate** and **Scale** set the gizmo.
- **Colliders** lists the simple collision shapes. **Add** offers **Box**, **Sphere**, **Capsule**, **Cylinder**, **Cone** and **Generated Collision**, a convex shape built from the mesh. **Delete** removes the selected one. Select a shape to edit its **Name**, **Position**, **Rotation**, **Scale** and its size (**Half Extents**, **Radius**, **Half Height** or **Height**).
- The **Inspector** has the material slots, **Level Of Detail** and **Clips**.

## Settings

| Setting | Description |
| --- | --- |
| Material slots | One row per material in the file. Pick a Material or Material Instance, or **Default** to keep the file's own material. |
| Auto LOD | Under **Level Of Detail**. Generates simpler meshes for distant views when the model loads. On by default. |
| Clips | The animation clips in the file. Read-only. |

## Use it

Drag a Model from **Place Actors > Models**, or set **Asset** on a [Mesh](../components/mesh.md) component. A Mesh set to **Use Simple Collision** uses the Model's colliders. A Model imported with a skeleton starts with none (other Models start with one **Generated Collision** shape), so add a shape under **Colliders** or set the Mesh to **Use Complex Collision**.

## Related

- [Models](../graphics/models.md)
- [Mesh](../components/mesh.md)
- [Collision](../physics/collision.md)
