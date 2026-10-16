---
node: bt.service.setBlackboard
---

# Set Blackboard

Writes a value to a Blackboard key at regular intervals while its node is active.

## Settings

| Setting | Default | Description |
| --- | --- | --- |
| Key |  | The Blackboard key to write. |
| Value | true | The value to store. It appears once you pick a key, and its editor matches the key's type. |
| Interval MS |  | How often the service writes, in milliseconds. The default is 250. |
| Random Deviation MS |  | Varies each interval by up to this many milliseconds, either way. The default is 0. |

## Notes

- Attach it to a node with **Add Service** in the **Inspector**.
- It runs while that node, or any of its children, is running.
