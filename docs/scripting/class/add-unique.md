---
node: array.addUnique
---

# Add Unique

Adds an item to a copy of an array unless it is already there.

## Inputs

| Pin | Type | Description |
| --- | --- | --- |
| In | Exec |  |
| Array | Array of Wildcard |  |
| Item | Wildcard |  |

## Outputs

| Pin | Type |
| --- | --- |
| Out | Exec |
| Out | Array of Wildcard |
| Index | Integer |

## Notes

- **Index** is where the item is in **Out**, whether it was added or found.
- Vectors, rotators, colors, transforms and structures match by value.
