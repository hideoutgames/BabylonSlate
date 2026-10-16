---
node: tags.add
---

# Add Tag

Returns a new TagContainer with a Tag added.

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
- A Tag that is already present is not added twice, and None is ignored.
