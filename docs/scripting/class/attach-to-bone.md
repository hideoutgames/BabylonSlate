---
node: actor.attachToBone
---

# Attach To Bone

Attaches an actor to a named bone or socket of another actor's model so it follows it.

## Inputs

| Pin | Type | Description |
| --- | --- | --- |
| Exec | Exec |  |
| Actor | Actor Reference | The actor to attach. Left unconnected the pin shows **Self** and attaches the actor running the graph. |
| Target | Actor Reference | The actor whose model has the bone. |
| Bone Name | String | A bone or [socket](../../assets/skeleton.md#sockets) of Target's model. Type it, or pick it from any Skeleton's bones and sockets with the list button. |

## Outputs

| Pin | Type |
| --- | --- |
| Then | Exec |

## Notes

- **Bone Name** must match the bone or socket exactly, including capitalisation. A socket attaches at its offset from its bone. Nothing happens if the name is empty or either actor is invalid. An **Actor** or **Target** wired to a reference that is empty also logs an error (only an unconnected **Actor** means the actor running the graph).
- The actor snaps to the bone's origin and keeps its scale. Use [**Set Actor Transform**](set-actor-transform.md) afterwards to add an offset from the bone.
- [**Detach Actor**](detach-actor.md) releases the attachment.
