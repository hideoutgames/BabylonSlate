# Compare Blackboard Value

Lets a node run only while a Blackboard key compares true against a value.

## Settings

| Setting | Default | Description |
| --- | --- | --- |
| Key |  | The Blackboard key to compare. |
| Op | eq | How the key is compared with **Value**: Equal, Not Equal, Greater, Greater Or Equal, Less, Less Or Equal. |
| Value |  | The value to compare against. It appears once you pick a key, and its editor matches the key's type. |
| Abort Mode |  | Controls whether a change in the result interrupts running nodes: None, Self, Lower Priority or Both. |

## Notes

- Equal and Not Equal also compare vectors and other structured values field by field, while the other tests compare numbers.
- If the comparison is false the node fails without running; set **Abort Mode** to also interrupt a running node.
- Attach it to a node with **Add Decorator** in the **Inspector**.
