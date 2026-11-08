---
node: system.isInEditor
---

# Is In Editor

Returns true while the game runs inside the editor.

## Outputs

| Pin | Type | Description |
| --- | --- | --- |
| In Editor | Boolean | True in Play, Simulate and Editor Utility Objects. False in Preview Build and exported games. |

## Notes

- Useful for shortcuts while you test, such as starting at a chosen level.
- To also include debug exports, use [**Is Development Build**](is-development-build.md).
