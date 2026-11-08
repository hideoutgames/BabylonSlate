---
node: tags.getAllActorsWithTag
---

# Get All Actors With Tag

Returns every actor with Tag or, unless Exact Match is on, a child of it, in spawn order.

## Inputs

| Pin | Type |
| --- | --- |
| Tag | Tag |
| Exact Match | Boolean |

## Outputs

| Pin | Type |
| --- | --- |
| Actors | Array of Actor Reference |

## Notes

- A child Tag such as `Enemy.Boss` matches its parent `Enemy` unless **Exact Match** is on.
- Actors come in the order they were spawned.
- Checks every actor, so avoid calling it every tick in a large scene; keep the result in a variable instead.
