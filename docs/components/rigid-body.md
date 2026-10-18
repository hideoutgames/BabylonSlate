# Rigid Body

Makes an actor move under physics: gravity, forces and collisions.

## Add it

Select an actor, then choose **Add Component > Physics > Rigid Body**. It needs a shape on the same actor to collide with anything: a [Collider](collider.md), or a [Mesh](mesh.md) with collision on.

## Settings

| Setting | Description |
| --- | --- |
| Motion Type | **Static**, **Kinematic** or **Dynamic**. Static never moves. Kinematic is moved by scripts, not by forces. Dynamic is moved by physics. Default Dynamic. |
| Mass | Mass of the body, at least 0.001. Default 1. |
| Gravity Scale | Multiplies the scene's gravity, 0 to 10. Default 1. |
| Linear Damping | Slows movement over time, 0 to 10. Default 0. |
| Angular Damping | Slows spinning over time, 0 to 10. Default 0. |

A Static body shows only Motion Type, because the other settings do nothing.

## Notes

- Works in world scenes and in Scene Layers.
- The scene's **Physics World** setting, **3D** or **2D**, decides which kind of physics the body uses. A Scene Layer simulates in its own 2D world when its **Enable Physics** is on.
- Compiler Results warns about a Rigid Body with no shape to collide with, and about a Collider that has no Rigid Body and is therefore not simulated. Mesh collision, Tilemaps and Blocking Volumes are solid without a Rigid Body, and a Collider beside them is simulated too.
- Use **Motion Type** Static with a Collider for a trigger volume or a fixed collider.
- [Add Impulse](../scripting/class/add-impulse.md) pushes a Dynamic body from a script.
- Do not combine a Rigid Body with [Movement](movement.md) on one actor. Movement supplies its own body.

## Related

- [Physics](../physics/index.md)
- [Collision](../physics/collision.md)
- [Physics Constraint](physics-constraint.md)
