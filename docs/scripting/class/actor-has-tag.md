---
node: tags.actorHasTag
---

# Actor Has Tag

True when one of the actor's Tags is Tag or, unless Exact Match is on, a child of it.

## Inputs

| Pin | Type |
| --- | --- |
| Target | Actor Reference |
| Tag | Tag |
| Exact Match | Boolean |

## Outputs

| Pin | Type |
| --- | --- |
| Result | Boolean |

## Notes

- Leave **Target** unconnected to use the actor running the graph; the pin shows **Self**.
- A child Tag such as `Enemy.Boss` matches its parent `Enemy` unless **Exact Match** is on.
- Returns false for a missing actor.
