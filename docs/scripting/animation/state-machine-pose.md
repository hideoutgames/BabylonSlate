---
node: anim.pose.stateMachine
---

# State Machine

The pose of a State Machine's active state, blended through its transitions.

## Outputs

| Pin | Type |
| --- | --- |
| Pose | Pose |

## Notes

- Only in the Anim Graph. Each State Machine node owns one State Machine: adding the node adds a State Machine with an Idle state, and deleting it deletes that State Machine.
- Double-click or double-tap the node to open its State Machine.
- **Get Current State** and **Jump To State** use the first State Machine the Anim Graph plays.
