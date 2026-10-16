# Collider

Gives an actor a collision shape. It can block other colliders or act as a trigger.

## Add it

Select an actor, then choose **Add Component > Physics > Collider**. If the actor has a built-in shape Mesh, the Collider is sized to fit it. Pair it with a [Rigid Body](rigid-body.md).

## Settings

| Setting | Description |
| --- | --- |
| Shape Kind | 3D: **Box**, **Sphere**, **Capsule** or **Cylinder**. 2D: **Box 2D**, **Circle** or **Capsule 2D**. Changing it refits the shape to the Mesh when there is one. |
| Half Extents | Box. Half the size along each axis. Default 0.5. |
| Radius | Sphere, circle, capsule and cylinder. |
| Half Height | Capsule. Half the length of the straight section between the rounded ends. |
| Height | Cylinder. Full height. |
| Friction | Grip on contact, 0 to 1. Default 0.5. |
| Restitution | Bounciness, 0 to 1. Default 0. |
| Layer | The collision layer the collider is on. |
| Collides With | The layers it collides with. Default all. |
| Is Trigger | Detects overlaps without blocking. Default off. |
| Render In Game | Draws the shape in Play and exports. Default off. |
| Transform | Position, rotation and scale of the shape relative to the actor. |

## Notes

- Works in world scenes and in Scene Layers.
- The shape kinds depend on the scene's **Physics World**, 3D or 2D. Scene Layers use 2D shapes.
- A Collider is always drawn as a dashed outline in the editor.
- A blocking Collider runs [Event On Hit](../scripting/class/event-on-hit.md). A trigger runs [Event On Begin Overlap](../scripting/class/event-on-begin-overlap.md) and [Event On End Overlap](../scripting/class/event-on-end-overlap.md).
- Name layers in **Project Settings > Physics > Collision Layers**. Two colliders collide only if each one's Collides With includes the other's Layer.
- An actor can have several Colliders.

## Related

- [Collision](../physics/collision.md)
- [Physics](../physics/index.md)
