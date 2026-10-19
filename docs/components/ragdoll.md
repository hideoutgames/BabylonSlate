# Ragdoll

Turns a Model's skeleton into physics bodies that collapse from its current animation pose.

## Add it

Select an actor with a [Mesh](mesh.md) that uses a Model with a skeleton, then choose **Add Component > Physics > Ragdoll**. It does not appear in 2D scenes or in Scene Layers.

## Settings

| Setting | Description |
| --- | --- |
| Enabled | Starts the ragdoll. Enabling captures the current animation pose. Disabling releases it and animation resumes. Default off. 3D physics only. |
| Total Mass | Mass shared across the bones, in kilograms. Default 60. |
| Bone Radius | Collision radius of each bone, in scene units. Default 0.08. |
| Angular Limit | Furthest a joint can rotate from the captured pose, 0 to 180 degrees. Default 45. |
| Linear Damping | Slows movement over time. Default 0.05. |
| Angular Damping | Slows spinning over time. Default 0.3. |
| Friction | Grip on contact. Default 0.5. |
| Restitution | Bounciness, 0 to 1. Default 0. |
| Layer | The collision layer the bones are on. |
| Collides With | **Project Matrix** (default) follows the project Collision Matrix; **Custom** uses Layers. |
| Layers | The layers they collide with. Read only under Project Matrix. |
| Bone Names | Optional. Empty uses the whole skeleton. |

## Bone Names

For a partial ragdoll, add the exact names of bones that form one connected chain or subtree, including the parents that connect them. The other bones keep their captured pose. A ragdoll uses up to 128 bones.

## Notes

- World scenes only.
- One enabled Ragdoll per actor. Actor scale must be positive.
- While active, the bones replace the actor's ordinary collision. The actor follows the root bone.
- There is no get-up animation and no blend between animation and physics.
- [Add Impulse](../scripting/class/add-impulse.md) pushes the whole ragdoll. Set **Enabled** from a graph to trigger it.
- A smaller Bone Names set suits detailed characters.

## Related

- [Constraints and ragdolls](../physics/constraints.md)
- [Models](../graphics/models.md)
