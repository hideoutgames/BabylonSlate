# Collider

Gives an actor a collision shape. It can block other colliders or act as a trigger.

## Add it

Select an actor, then choose **Add Component > Physics > Collider**. If the actor has a built-in shape Mesh, the Collider is sized to fit it. Pair it with a [Rigid Body](rigid-body.md).

A Collider is simulated only on an actor that has a body: a Rigid Body, or a [Mesh](mesh.md) with collision on, a [Blocking Volume](blocking-volume.md), a Tilemap or enabled Landscape collisions, which are static bodies of their own and take the Collider's shape too. On any other actor the Collider is ignored and **Compiler Results** warns that it is not simulated. For a trigger volume or a fixed collider, add a Rigid Body and set its **Motion Type** to **Static**.

## Settings

| Setting | Description |
| --- | --- |
| Shape Kind | 3D: **Box**, **Sphere**, **Capsule** or **Cylinder**. 2D: **Box 2D**, **Circle** or **Capsule 2D**. Changing it refits the shape to the Mesh when there is one. |
| Half Extents | Box and Box 2D. Half the size along each axis. Default 0.5. A Box 2D on an actor whose [Sprite](../assets/sprite.md) has an asset takes its size and position from the Sprite's collision box instead, so Half Extents is disabled and has no effect. |
| Radius | Sphere, circle, capsule and cylinder. |
| Half Height | Capsule. Half the length of the straight section between the rounded ends. |
| Height | Cylinder. Full height. |
| Friction | Grip on contact, 0 to 1. Default 0.5. |
| Restitution | Bounciness, 0 to 1. Default 0. |
| Layer | The collision layer the collider is on. |
| Collision Preset | A project Collision Preset (default **Default**) or **Custom**. |
| Collision Responses | Ignore, Overlap or Block for every layer. Default Block. |
| Is Trigger | Detects overlaps without blocking. Default off. |
| Render In Game | Draws the shape in Play and exports. Default off. |
| Transform | Position, rotation and scale of the shape relative to the actor. |

## Notes

- Works in world scenes and in Scene Layers.
- The shape kinds depend on the scene's **Physics World**, 3D or 2D. Scene Layers use 2D shapes.
- A Collider is always drawn as a dashed outline in the editor.
- A blocking Collider runs [Event On Hit](../scripting/class/event-on-hit.md). A trigger runs [Event On Begin Overlap](../scripting/class/event-on-begin-overlap.md) and [Event On End Overlap](../scripting/class/event-on-end-overlap.md).
- Name layers in **Project Settings > Physics > Collision Layers** and define presets in **Collision Presets**. Layer and Collision Responses are read only unless the Collision Preset is Custom. Two colliders block each other only when both Block the other's Layer; Overlap on either side makes them overlap instead. See [Collision](../physics/collision.md#collision-presets).
- An actor can have several Colliders.
- In 2D, only Box 2D follows the Sprite's collision box. Circle and Capsule 2D keep the size you set. See [Sprites](../2d/sprites.md#collision).

## Related

- [Collision](../physics/collision.md)
- [Physics](../physics/index.md)
