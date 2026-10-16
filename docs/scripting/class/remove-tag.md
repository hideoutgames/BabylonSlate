---
node: tags.remove
---

# Remove Tag

Returns a new TagContainer without a given Tag.

## Inputs

| Pin | Type |
| --- | --- |
| Container | TagContainer |
| Tag | Tag |

## Outputs

| Pin | Type |
| --- | --- |
| Container | TagContainer |

## Notes

- The input container is not changed; assign the result to keep it, for example with [**Assign TagContainer**](assign-tagcontainer.md).
- Only that exact Tag is removed, not its parents or children.
