---
node: system.newGuid
---

# New GUID

Returns a new random identifier.

## Outputs

| Pin | Type | Description |
| --- | --- | --- |
| GUID | String | A unique identifier such as `3f2b8c1e-…`. |

## Notes

- Each read returns a new value. To use one identifier in several places, store it in a variable first.
- Useful for naming save slots, or for marking objects that must stay unique across sessions.
