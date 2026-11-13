---
node: anim.pose.blendByBool
---

# Blend Poses By Bool

Blends to True Pose or False Pose as Active changes.

## Inputs

| Pin | Type | Description |
| --- | --- | --- |
| True Pose | Pose | The pose while Active is true. |
| False Pose | Pose | The pose while Active is false. |
| Active | Boolean | Which pose to blend to. Defaults to true. |

## Outputs

| Pin | Type |
| --- | --- |
| Pose | Pose |

## Notes

- Set **True Blend Time** and **False Blend Time** in the **Inspector**: how long, in seconds, the blend to each pose takes.
