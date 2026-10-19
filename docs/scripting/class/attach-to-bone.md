---
node: actor.attachToBone
---

# Attach To Bone

Attaches an actor to a named bone of another actor's model so it follows that bone.

## Inputs

| Pin | Type | Description |
| --- | --- | --- |
| Exec | Exec |  |
| Actor | Actor Reference | The actor to attach. Left unconnected the pin reads **Actor (Self)** and attaches the actor running the graph. |
| Target | Actor Reference | The actor whose model has the bone. |
| Bone Name | String |  |

## Outputs

| Pin | Type |
| --- | --- |
| Then | Exec |

## Notes

- **Bone Name** must match the bone exactly, including capitalisation. Nothing happens if the name is empty or either actor is invalid. An **Actor** or **Target** wired to a reference that is empty also logs an error (only an unconnected **Actor** means the actor running the graph).
- The actor snaps to the bone's origin and keeps its scale. Use [**Set Actor Transform**](set-actor-transform.md) afterwards to add an offset from the bone.
- [**Detach Actor**](detach-actor.md) releases the attachment.
