# Blackboard Is Set

Lets a node run only while a Blackboard key has a value.

## Settings

| Setting | Description |
| --- | --- |
| Key | The Blackboard key to check. |
| Abort Mode | Controls whether a change in the result interrupts running nodes: None, Self, Lower Priority or Both. |

## Notes

- A key counts as set unless it has no value or is false, and the node fails without running when the check fails.
- Set **Abort Mode** to stop the node when the key becomes unset, or to interrupt lower-priority branches when it becomes set.
- Attach it to a node with **Add Decorator** in the **Inspector**.
