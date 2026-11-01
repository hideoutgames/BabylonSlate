---
node: object.collectGarbage
---

# Collect Garbage

Collects the objects made by **Create Object** that nothing refers to any more, at the end of the current tick.

## Inputs

| Pin | Type |
| --- | --- |
| In | Exec |

## Outputs

| Pin | Type |
| --- | --- |
| Out | Exec |

## Notes

- Haptic also collects on its own, about once a second while created objects exist, and when the main Scene changes. Use this node when you want an object gone before then, for example in a test.
- Collected objects run no events. See [Objects and lifetime](../object-lifetime.md).
