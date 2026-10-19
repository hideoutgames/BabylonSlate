# Mesh

Draws a built-in shape or a Model, with a Material, shadows and optional collision.

## Add it

Select an actor, then choose **Add Component > Rendering > Mesh**. You can also place a ready-made actor from **Place Actors > Shapes** (Box, Sphere, Cylinder, Plane or Ground), or place a Model from **Place Actors > Models**.

## Settings

| Setting | Description |
| --- | --- |
| Mesh Kind | Box, Sphere, Cylinder, Plane or Ground. Shown only while no Asset is set. Default Box. |
| Asset | A [Model](../assets/model.md). It replaces the built-in shape. |
| Material | A Material or Material Instance. With a Model, the default is the Model's own materials. |
| Collision | **Use Simple Collision**, **Use Complex Collision** or **No Collision**. Default No Collision. 3D physics only. |
| Layer | The collision layer this mesh is on. Shown when Collision is on. |
| Collides With | **Project Matrix** (default) follows the project Collision Matrix; **Custom** uses Layers. Shown when Collision is on. |
| Layers | The layers this mesh collides with. Read only under Project Matrix. Shown when Collision is on. |
| Cast Shadows | Casts shadows. Default on. |
| Receive Shadows | Receives shadows. Default on. |

## Notes

- Works in world scenes and in Scene Layers.
- Simple collision uses the Model's simple colliders, or the built-in shape for a primitive. Complex collision uses the visible triangles and does not follow skeletal animation.
- A Model with a skeleton starts with no simple colliders, so **Use Simple Collision** produces no collision for it. Add shapes under the Model's **Colliders**, or use **Use Complex Collision**. Compiler Results warns about this.
- A Mesh with collision on is solid without a Rigid Body. Add a [Rigid Body](rigid-body.md) to make it move. A [Collider](collider.md) on the same actor adds its shape to the Mesh's body, for example as a trigger volume.
- **No Collision** makes no body. A Collider on that actor then needs a Rigid Body.
- Mesh collision works only in a 3D physics world. In a 2D scene the **Collision** setting is hidden, the Mesh does not collide, and Compiler Results warns when it was left on.
- Name collision layers in **Project Settings > Physics > Collision Layers** and set which pairs collide in **Collision Matrix**.
- Add a [Deformer](deformer.md) or [Outline](outline.md) to the same actor to bend or outline the mesh.

## Related

- [Models](../graphics/models.md)
- [Materials](../graphics/materials.md)
- [Collision](../physics/collision.md)
