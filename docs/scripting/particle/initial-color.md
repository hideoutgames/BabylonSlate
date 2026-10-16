---
node: input.contextual.initialColor
---

# Initial Color

Returns the colour the particle was created with.

## Outputs

| Pin | Type |
| --- | --- |
| Initial Color | Color |

## Notes

- It stays fixed for the particle's life, so read it in [**Update Color**](update-color.md) to keep the starting colour.
- Reads the particle being processed, so it gives no value in **Emit Rate**.
