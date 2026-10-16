# Blackboard

Shared keys that a Behaviour Tree reads and writes.

## Create

In the **Content Browser**, choose **New Asset > AI > Blackboard**.

## Editor

Double-tap a Blackboard to open it. The editor has two panels.

- **Keys**: a button for each key, and **Add Key**.
- **Inspector**: the settings of the selected key. Tap **Delete Key** to remove it.

## Settings

| Setting | Description |
| --- | --- |
| Name | The key's name. Tree nodes refer to the key by this name. |
| Type | The kind of value the key holds, such as **Bool**, **Float**, **String** or **Vector 3**. For an **Enum** or **Structure / Data Definition** key, also pick the **Enum Type** or **Record Type**. See [Pin Types](../scripting/pin-types.md). |
| Default | The value the key starts with. The fields depend on the type. |

## Notes

- A Behaviour Tree uses one Blackboard. Pick it in the tree's **Blackboard** window. The [Behaviour Tree component](../components/behaviour-tree.md) can use another Blackboard instead.
- Keys are listed in the tree for reference; edit them here.
- Read and write keys from tree nodes, or from a custom node with [Get Blackboard](../scripting/class/get-blackboard.md) and [Set Blackboard](../scripting/class/set-blackboard.md).

## Related

- [Behaviour Trees](../ai/behaviour-trees.md)
- [Behaviour Tree](behaviour-tree.md)
- [Structures and Enums](../scripting/structures-and-enums.md)
