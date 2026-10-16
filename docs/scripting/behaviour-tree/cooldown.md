---
node: bt.decorator.cooldown
---

# Cooldown

Stops a node from running again for a set time after it finishes.

## Settings

| Setting | Default | Description |
| --- | --- | --- |
| Duration MS | 1000 | How long the node is blocked, in milliseconds. |

## Notes

- While the cooldown runs, the node fails straight away, so a Selector moves on to its next child.
- The cooldown starts when the node finishes or is aborted.
