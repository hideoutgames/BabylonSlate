---
node: bt.decorator.loop
---

# Loop

Repeats the node it is attached to.

## Settings

| Setting | Default | Description |
| --- | --- | --- |
| Num Loops | 0 | How many times the node runs in total. 0 repeats forever. |

## Notes

- It repeats whether the node succeeds or fails.
- With **Num Loops** at 0 the node repeats forever, so the tree stays on it until something aborts it.
- Each repeat of a node that waits takes at least one frame.
