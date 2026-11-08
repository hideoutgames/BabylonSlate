---
node: random.seededArrayItem
---

# Seeded Random Array Item

Returns a random item of the Array and its index.

## Inputs

| Pin | Type | Description |
| --- | --- | --- |
| Seed | Seed | A Seed variable. Its Step moves on by the values drawn. |
| Array | Array of Wildcard |  |

## Outputs

| Pin | Type | Description |
| --- | --- | --- |
| Item | Wildcard |  |
| Index | Integer | The index of **Item**, or -1 when the Array is empty. |

## Notes

- Draws from **Seed** instead of the global seed, so the same Seed and Step give the same result on every device. [Random Array Item](random-array-item.md) draws from the global seed.
- **Seed** is a [reference pin](../pin-types.md#reference-pins): connect a Seed variable, not a value.
- Takes one step, or none for an empty Array. Each step adds 1 to the Seed variable's **Step**.
- An empty Array returns the type's default value, such as 0 or an empty string, at **Index** -1.
- **Item** and **Index** read from one node always belong together.
