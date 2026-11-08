---
node: tags.addActorTag
---

# Add Actor Tag

Gives the actor Tag for the rest of its life, unless removed.

## Inputs

| Pin | Type |
| --- | --- |
| In | Exec |
| Target | Actor Reference |
| Tag | Tag |

## Outputs

| Pin | Type |
| --- | --- |
| Out | Exec |

## Notes

- Leave **Target** unconnected to use the actor running the graph; the pin shows **Self**.
- The Tag lasts until [Remove Actor Tag](remove-actor-tag.md) takes it off or the actor is destroyed; it is not saved to the scene.
- Adding a Tag the actor already has changes nothing.
- If **Target** is empty when the node runs, nothing happens and an error is logged.
