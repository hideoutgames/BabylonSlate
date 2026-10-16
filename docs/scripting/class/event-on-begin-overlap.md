---
node: flow.event.beginOverlap
---

# Event On Begin Overlap

Runs when the actor's collider starts overlapping another actor, where one of the two is a trigger.

## Outputs

| Pin | Type | Description |
| --- | --- | --- |
| Out | Exec |  |
| Instigator | Actor Reference | The other actor in the overlap. |

## Notes

- Needs **Generate Overlap Events** on in **Actor Defaults** (on by default), and at least one of the two colliders set to **Is Trigger**.
- An overlap that already exists when Play starts also runs this event.
- Belongs to a **Collider** component on an Actor.
