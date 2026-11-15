---
node: anim.pose.blend
---

# Blend

Blends two poses by Alpha: 0 is A, 1 is B.

## Inputs

| Pin | Type | Description |
| --- | --- | --- |
| A | Pose | The pose at Alpha 0. |
| B | Pose | The pose at Alpha 1. |
| Alpha | Float | How far to blend from A to B, from 0 to 1. Defaults to 0.5. |

## Outputs

| Pin | Type |
| --- | --- |
| Pose | Pose |

## Notes

- Both inputs keep playing whatever the Alpha, so a clip does not restart when its weight rises again.
- Wire a variable such as Speed into **Alpha**, through math nodes, to blend walk into run.
