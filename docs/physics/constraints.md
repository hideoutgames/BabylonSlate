# Constraints and Ragdolls

Join physics bodies with joints, or let a character's skeleton fall and tumble as a ragdoll.

## Connect two bodies

1. Select an actor with physics and choose **Add Component > Physics > Physics Constraint**.
2. Pick the **Target Actor**: another physics actor in the scene. Its Rigid Body, Mesh collision or Blocking Volume all count.
3. Choose the **Constraint Type** and set the anchors.

At least one of the two bodies must be dynamic, or nothing moves. Leave **Target Actor** empty to keep the constraint unconnected. In a Class, choose the target after placing the Class in a scene, or call **Set Connected Actor** from a graph.

| Constraint Type | Behaviour |
| --- | --- |
| Fixed | Locks the bodies together, including their relative rotation. |
| Ball Socket | Keeps the anchors together while both bodies rotate freely. Called **Pivot** in 2D. |
| Hinge | Rotates around one axis, like a door. In 2D it rotates around Z. |
| Distance | Keeps the anchors at an exact distance apart. 3D only. It is not a rope with a maximum length. |

## Constraint settings

| Setting | Description |
| --- | --- |
| Enabled | Creates the joint during Play. On by default. |
| Collide Connected | Lets the two connected bodies collide. Off by default. |
| Local Anchor | Connection point in this actor's local space, in scene units. |
| Target Local Anchor | Connection point in the target actor's local space. |
| Local Frame Rotation, Target Frame Rotation | Fixed only. The locked relative orientation, in degrees. |
| Local Hinge Axis, Target Hinge Axis | Hinge only. The rotation axis in each body's local space. |
| Local Reference Axis, Target Reference Axis | Hinge only. The direction that counts as zero degrees. It must not be parallel to the hinge axis. |
| Angle Limits | Hinge only. Restricts rotation to **Minimum Angle** and **Maximum Angle**, from -180 to 180 degrees (default -45 and 45). |
| Distance | Distance only. The separation between the anchors, in scene units. Default 1. |

Chain several actors with constraints to build bridges, pendulums or machines.

## Ragdolls

A Ragdoll turns a skinned Model's skeleton into connected physics bodies, starting from its current animation pose. 3D scenes only.

1. Select an actor whose Mesh uses a Model with a skeleton.
2. Choose **Add Component > Physics > Ragdoll**.
3. Turn on **Enabled**, in the **Inspector** or from a graph, when the character should go limp.

| Setting | Default | Description |
| --- | --- | --- |
| Enabled | Off | On captures the current pose and starts the ragdoll. Off returns control to animation. |
| Bone Names | Empty | Empty simulates the whole skeleton. List connected bones, by exact name, to simulate only that part. |
| Total Mass | 60 | Mass shared by the simulated bones, in kilograms. |
| Bone Radius | 0.08 | Collision radius of each bone, in scene units. |
| Angular Limit | 45 | Largest rotation from the captured pose, in degrees. |
| Linear Damping, Angular Damping | 0.05, 0.3 | Slow the bones down over time. |
| Friction, Restitution | 0.5, 0 | Surface response of the bones. |
| Layer, Collides With | Default, all | See [Collision](collision.md). |

While the ragdoll is active:

- The bones replace the actor's usual collision, and the actor follows the ragdoll's root.
- **Add Impulse** on the Ragdoll pushes the whole body. An impulse sent just after enabling still applies.
- Bones outside **Bone Names** hold their captured pose.

Turning the ragdoll off resumes animation where the game is now. There is no built-in get-up animation or blend.

## Limits

- One enabled Ragdoll per actor, with up to 128 bones. Use a smaller **Bone Names** list for detailed models.
- The actor's scale must be positive.
- Ragdolls are not available in 2D scenes or Scene Layers.

## Related

- [Physics Constraint](../components/physics-constraint.md)
- [Ragdoll](../components/ragdoll.md)
- [Models](../graphics/models.md)
- [Add Impulse](../scripting/class/add-impulse.md)
