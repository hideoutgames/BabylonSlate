# Behaviour Tree

An AI tree of composites, tasks and decorators that decides what an actor does next.

## Create

In the **Content Browser**, choose **New Asset > AI > Behaviour Tree**. A new tree starts with a **Selector** root, one **Sequence** and a **Succeed** task.

## Editor

Double-tap a Behaviour Tree to open it.

- **Graph**: the tree. Select a composite and choose **Add Node** to add a child. Children run left to right; drag a node sideways to reorder. Long-press a node for **Add Decorator**, **Wrap In Sequence**, **Duplicate** and **Delete**.
- **Blackboard**: the tree's Blackboard asset and a read-only list of its keys. While a Simulation runs it also shows the live values of the actor you watch.
- **Inspector**: settings for the selected node.
- **Compiler Results**: problems such as an empty composite or a missing Blackboard key. Tap a row to select the node.

## Watch the tree run

Start a Simulation with the tree open and pick an actor in **Debug Instance**. The nodes the tree works on light up, and each node shows **Running**, **Success** or **Failure**. See [Watch a graph run](../debugging/index.md#behaviour-trees).

## Settings

| Setting | Description |
| --- | --- |
| Blackboard | The [Blackboard](blackboard.md) the tree reads and writes. Set it in the **Blackboard** window. |
| Class | The selected node's type, such as a composite or a task. |

With a decorator or service selected:

| Setting | Description |
| --- | --- |
| Decorator | The condition's type. |
| Abort Mode | **None**, **Self**, **Lower Priority** or **Both**. Decides what happens when the condition changes. |
| Observed Keys | Blackboard keys that trigger the check again. **Add Key** adds one. |
| Service | The service's type. |
| Interval MS | How often the service runs. |
| Random Deviation MS | Random offset added to the interval. |

Tasks and decorators add their own settings. See the [node reference](../scripting/behaviour-tree/index.md).

## Notes

- Add a [Behaviour Tree component](../components/behaviour-tree.md) to an actor to run the tree.
- Movement tasks also need a Nav Agent and a baked NavMesh.

## Related

- [Behaviour Trees](../ai/behaviour-trees.md)
- [Blackboard](blackboard.md)
- [Navigation](../ai/navigation.md)
- [Class](class.md)
