# Behaviour Tree

Runs a Behaviour Tree on an actor to drive its AI.

## Add it

Select an actor, then choose **Add Component > AI > Behaviour Tree**.

## Settings

| Setting | Description |
| --- | --- |
| Behaviour Tree | The [Behaviour Tree](../assets/behaviour-tree.md) to run. |
| Blackboard | Optional. A [Blackboard](../assets/blackboard.md) to use instead of the one linked to the tree. Empty uses the tree's own. |

## Notes

- Works in world scenes and in Scene Layers.
- The tree starts when Play begins and ticks every frame.
- If you change the tree or the Blackboard during Play, the running tasks are aborted and the new tree starts from its root with fresh Blackboard defaults.
- Tasks that move the actor, such as [Move To](../scripting/behaviour-tree/move-to.md), need a [Nav Agent](nav-agent.md) on the actor and a baked [NavMesh](nav-mesh.md).
- Read and write Blackboard values from other graphs with [Set Blackboard](../scripting/class/set-blackboard.md) and [Get Blackboard](../scripting/class/get-blackboard.md).

## Related

- [Behaviour trees](../ai/behaviour-trees.md)
- [Behaviour Tree nodes](../scripting/behaviour-tree/index.md)
