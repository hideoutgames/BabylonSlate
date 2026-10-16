---
node: input.exportBindings
---

# Export Input Bindings

Returns the player's binding changes as text that can be saved.

## Outputs

| Pin | Type |
| --- | --- |
| Data | String |

## Notes

- The text holds only the changes made to the authored bindings.
- Store it yourself, for example in save data, and pass it to [**Import Input Bindings**](import-input-bindings.md) later.
