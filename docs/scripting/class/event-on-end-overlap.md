---
node: flow.event.endOverlap
---

# Event On End Overlap

Runs when the actor's collider stops overlapping another actor it was overlapping.

## Outputs

| Pin | Type | Description |
| --- | --- | --- |
| Out | Exec |  |
| Instigator | Actor Reference | The other actor in the overlap. |

## Notes

- Pairs with [**Event On Begin Overlap**](event-on-begin-overlap.md), and needs **Generate Overlap Events** on in **Actor Defaults** (on by default).
- Belongs to a **Collider** component on an Actor.
