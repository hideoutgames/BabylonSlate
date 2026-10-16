---
node: actor.attach
---

# Attach Actor

Makes an actor a child of another actor so it follows its parent.

## Inputs

| Pin | Type |
| --- | --- |
| In | Exec |
| Target | Actor Reference |
| Parent | Actor Reference |

## Outputs

| Pin | Type |
| --- | --- |
| Out | Exec |

## Notes

- **Target** keeps its location, rotation and scale values, which now apply relative to **Parent**.
- Attaching an actor to one of its own descendants is refused, and a warning is written to the log.
- Any bone attachment on **Target** is released.
