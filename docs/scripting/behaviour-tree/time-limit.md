---
node: bt.decorator.timeLimit
---

# Time Limit

Fails a node if it runs for longer than a set time.

## Settings

| Setting | Default | Description |
| --- | --- | --- |
| Duration MS | 1000 | The longest the node may run, in milliseconds. |

## Notes

- The node is aborted when the limit passes, so a long [**Wait**](wait.md) or [**Move To**](move-to.md) cannot stall the tree.
