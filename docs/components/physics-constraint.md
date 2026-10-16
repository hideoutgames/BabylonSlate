# Physics Constraint

Connects this actor's body to another actor's body with a fixed, ball socket, hinge or distance joint.

## Add it

Select an actor, then choose **Add Component > Physics > Physics Constraint**. Both actors need collision, and at least one must be Dynamic.

## Settings

| Setting | Description |
| --- | --- |
| Enabled | Connects the bodies during Play. Default on. |
| Target Actor | The other actor. Pick a physics actor in the scene. Empty leaves the constraint unconnected. |
| Constraint Type | **Fixed**, **Ball Socket** (**Pivot** in 2D), **Hinge** or **Distance** (3D only). Default Ball Socket. |
| Collide Connected | Lets the two bodies collide with each other. Default off. |
| Local Anchor | Connection point in this actor's local space. |
| Target Local Anchor | Connection point in the target actor's local space. |

Each type adds its own settings:

| Type | Settings |
| --- | --- |
| Fixed | **Local Frame Rotation** and **Target Frame Rotation** set the locked relative orientation, in degrees. |
| Hinge | **Local Hinge Axis**, **Target Hinge Axis**, **Local Reference Axis** and **Target Reference Axis** (3D), and **Angle Limits** with **Minimum Angle** and **Maximum Angle** (default -45 and 45). |
| Distance | **Distance** keeps the anchors exactly this far apart. It is not a maximum rope length. |

## Notes

- Works in world scenes and in Scene Layers.
- Ball Socket keeps the anchors together and leaves rotation free. A hinge rotates around one axis. In 2D it rotates around Z.
- A hinge's reference axis sets zero angle and must not be parallel to its hinge axis.
- In a Class or Prefab, set the target after you place it in a scene, or use the component's **Set Connected Actor** function.
- Duplicating a connected selection reconnects the copies to each other.

## Related

- [Constraints and ragdolls](../physics/constraints.md)
- [Rigid Body](rigid-body.md)
