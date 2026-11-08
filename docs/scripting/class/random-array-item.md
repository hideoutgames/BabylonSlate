---
node: random.arrayItem
---

# Random Array Item

Returns a random item of the Array and its index.

## Inputs

| Pin | Type |
| --- | --- |
| Array | Array of Wildcard |

## Outputs

| Pin | Type | Description |
| --- | --- | --- |
| Item | Wildcard |  |
| Index | Integer | The index of **Item**, or -1 when the Array is empty. |

## Notes

- An empty Array returns the type's default value, such as 0 or an empty string, at **Index** -1.
- **Item** and **Index** read from one node always belong together.
- Draws from the global seed, which each Play session starts afresh; see [Random numbers](../random-numbers.md).
- [Seeded Random Array Item](seeded-random-array-item.md) draws from a Seed variable instead.
