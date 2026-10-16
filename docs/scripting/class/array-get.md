---
node: array.get
---

# Array Get

Returns the item at an index, and whether that index exists.

## Inputs

| Pin | Type |
| --- | --- |
| Array | Array of Wildcard |
| Index | Integer |

## Outputs

| Pin | Type | Description |
| --- | --- | --- |
| Out | Wildcard |  |
| Valid | Boolean | True when **Index** points at an item in the array. |

## Notes

- Indexes start at 0. A negative or out-of-range **Index** returns the type's default value, such as 0, an empty string or false.
