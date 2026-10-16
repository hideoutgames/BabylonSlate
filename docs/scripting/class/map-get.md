---
node: map.get
---

# Map Get

Returns the value stored for a key, and whether the key exists.

## Inputs

| Pin | Type |
| --- | --- |
| Map | Map of Wildcard to Wildcard |
| Key | Wildcard |

## Outputs

| Pin | Type | Description |
| --- | --- | --- |
| Value | Wildcard | The stored value, or the type's default value when the key is missing. |
| Found | Boolean | True when the map contains **Key**. |

## Notes

- When the key is missing, **Value** is the type's default value, such as 0, an empty string or false.
