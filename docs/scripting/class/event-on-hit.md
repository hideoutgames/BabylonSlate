---
node: flow.event.hit
---

# Event On Hit

Runs on each physics step that the actor's collider touches another solid collider.

## Outputs

| Pin | Type | Description |
| --- | --- | --- |
| Out | Exec |  |
| Hit Result | HitResult | Contact details: the location, normal and other actor. |
| Other Actor | Actor Reference | The actor that this collider touched. |
| Location | Vector 3 | World position of the contact. |
| Normal | Vector 3 | Contact normal, pointing from this actor towards the other one. |

## Notes

- Runs on both actors involved, and needs **Generate Hit Events** on in **Actor Defaults** (on by default).
- Colliders set to **Is Trigger** raise overlap events instead.
- Belongs to a **Collider** component on an Actor.
