---
node: actor.setOwner
---

# Set Owner

Records an actor as the owner of another actor, without attaching or moving it.

## Inputs

| Pin | Type |
| --- | --- |
| In | Exec |
| Target | Actor Reference |
| Owner | Actor Reference |

## Outputs

| Pin | Type |
| --- | --- |
| Out | Exec |

## Notes

- Ownership is separate from attachment and does not change either actor's transform.
- An empty **Owner** clears the link. A destroyed owner leaves the existing owner unchanged.
