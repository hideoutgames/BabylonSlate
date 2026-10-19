# Behaviour Trees

A Behaviour Tree decides what an actor does next, and its Blackboard holds the values the tree reads and writes.

## Create a tree and a Blackboard

1. In the **Content Browser**, choose **New Asset > AI > Blackboard**. Open it, tap **Add Key** for each value the AI needs, and set each key's **Name**, **Type** and default value. Integer, Float and Vector keys can also have a **Unit**, such as **Seconds**, shown after their values.
2. Choose **New Asset > AI > Behaviour Tree** and open it. A new tree starts with a **Selector** root, one **Sequence** and a **Succeed** task.
3. In the tree's **Blackboard** window, pick the Blackboard asset. Its keys are listed there for reference; edit them in the Blackboard asset.

The tree editor has four windows: **Graph**, **Blackboard**, the **Inspector** for the selected node, and **Compiler Results**.

## Build the tree

- Select a composite, then use **Add Node** in the Graph toolbar. The new node becomes its last child.
- Children run from left to right. Drag a node sideways to change its place; the number on each node shows its order.
- Long-press a node for **Add Decorator**, **Wrap In Sequence**, **Duplicate** and **Delete**. The root cannot be duplicated or deleted.
- **Auto Arrange** tidies the layout without changing the order.
- Select a node to edit its settings in the **Inspector**, where **Add Decorator** and **Add Service** attach extra rows to it.

| Composite | Runs |
| --- | --- |
| [Selector](../scripting/behaviour-tree/selector.md) | Children in order until one succeeds. |
| [Sequence](../scripting/behaviour-tree/sequence.md) | Children in order until one fails. |
| [Parallel](../scripting/behaviour-tree/parallel.md) | All children every tick. Fails if any fails, succeeds when all succeed. |

**Tasks** are the leaves that act: [Wait](../scripting/behaviour-tree/wait.md), [Move To](../scripting/behaviour-tree/move-to.md), [Move To Blackboard Key](../scripting/behaviour-tree/move-to-blackboard-key.md), [Rotate To Face](../scripting/behaviour-tree/rotate-to-face.md), [Play Animation](../scripting/behaviour-tree/play-animation.md), [Play Sound](../scripting/behaviour-tree/play-sound.md), [Set Blackboard](../scripting/behaviour-tree/set-blackboard.md), [Succeed](../scripting/behaviour-tree/succeed.md) and [Fail](../scripting/behaviour-tree/fail.md).

**Decorators** are conditions on a node: [Blackboard Is Set](../scripting/behaviour-tree/blackboard-is-set.md), [Compare Blackboard Value](../scripting/behaviour-tree/compare-blackboard-value.md), [Cooldown](../scripting/behaviour-tree/cooldown.md), [Loop](../scripting/behaviour-tree/loop.md) and [Time Limit](../scripting/behaviour-tree/time-limit.md).

**Services** run on a timer while their node is active. The built-in [Set Blackboard](../scripting/behaviour-tree/set-blackboard-service.md) service writes a key every **Interval** (default 250 ms), offset by up to **Random Deviation**.

## Aborts

Each decorator's **Abort Mode** decides what happens when its result changes:

| Abort Mode | Effect |
| --- | --- |
| None | The condition is checked only when the node starts. |
| Self | Stops this node's branch when the condition becomes false. |
| Lower Priority | Interrupts a lower-priority branch (one further right under the same Selector) when the condition becomes true. |
| Both | Self and Lower Priority together. |

**Observed Keys** lists the Blackboard keys that trigger the check.

## Custom tasks, decorators and services

Create a Class whose parent is **BTTask**, **BTDecorator** or **BTService**. It then appears in **Add Node**, **Add Decorator** or **Add Service**.

| Parent class | Events and nodes |
| --- | --- |
| BTTask | [On Activate](../scripting/class/on-activate.md), [On Tick](../scripting/class/on-tick.md) and [On Abort](../scripting/class/on-abort.md). Call [Finish Execute](../scripting/class/finish-execute.md) to end the task. |
| BTDecorator | [On Evaluate](../scripting/class/on-evaluate.md), answered with [Return Condition](../scripting/class/return-condition.md). |
| BTService | [On Tick](../scripting/class/on-tick.md). |

Read and write keys with [Get Blackboard](../scripting/class/get-blackboard.md) and [Set Blackboard](../scripting/class/set-blackboard.md). Double-tap a custom node or row to open its Class.

## Run the tree

1. Select the actor and choose **Add Component > AI > Behaviour Tree**.
2. Set **Behaviour Tree** to your tree. Leave **Blackboard** empty to use the tree's own Blackboard, or pick another to override it.
3. For movement tasks, also add a **Nav Agent** and bake a NavMesh. See [Navigation](navigation.md).

The tree starts from its root when Play begins, and restarts from the root each time it finishes.

## Debug the tree

- **Compiler Results** lists problems such as an empty composite or a missing Blackboard key. Tap a row to select the node.
- During a Simulation, open the tree and pick an actor in **Debug Instance**. The nodes the tree works on light up in orange, each node shows its **Running**, **Success** or **Failure** status, and the **Blackboard** window shows the actor's live values ([Watch a graph run](../debugging/index.md#behaviour-trees)).
- During Play, type `behaviourtreedebug` in the [console](../debugging/console.md) to open the **Behaviour Tree Debugger**. Choose an actor to see its current node, execution stack, node results, decorators, services and live Blackboard values.
- After Play, errors from a tree node in the **Preview Session Report** open the tree at that node.

## Related

- [Behaviour Tree asset](../assets/behaviour-tree.md)
- [Blackboard asset](../assets/blackboard.md)
- [Behaviour Tree component](../components/behaviour-tree.md)
- [Behaviour Tree node reference](../scripting/behaviour-tree/index.md)
