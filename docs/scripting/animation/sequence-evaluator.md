---
node: anim.pose.sequenceEvaluator
---

# Sequence Evaluator

Holds an Animation at a normalized time.

## Inputs

| Pin | Type | Description |
| --- | --- | --- |
| Normalized Time | Float | The point in the clip to show, from 0 (start) to 1 (end). Defaults to 0. |

## Outputs

| Pin | Type |
| --- | --- |
| Pose | Pose |

## Notes

- Pick its **Animation** in the **Inspector**.
- It does not advance on its own. Wire a value into **Normalized Time** to scrub the clip, such as a door opening with a variable.
