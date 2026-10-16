---
node: actor.getParent
---

# Get Parent

Returns the actor that another actor is attached to.

## Inputs

| Pin | Type |
| --- | --- |
| Target | Actor Reference |

## Outputs

| Pin | Type |
| --- | --- |
| Out | Actor Reference |

## Notes

- Returns an empty reference when the actor has no parent or the parent has been destroyed.
