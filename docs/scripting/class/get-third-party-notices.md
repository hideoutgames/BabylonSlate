---
node: project.getThirdPartyNotices
---

# Get Third-Party Notices

Reads the licence notices of the open-source software your game runs on, so you can show them on a credits or legal screen.

## Inputs

| Pin | Type | Description |
| --- | --- | --- |
| Exec | Exec |  |

## Outputs

| Pin | Type | Description |
| --- | --- | --- |
| Completed | Exec |  |
| Failed | Exec |  |
| Notices | String | The full notices text. Empty when the read failed. |
| Error | String | Why the notices could not be read. Empty when it succeeded. |

## Notes

- The text is the same as `legal/THIRD-PARTY-NOTICES.txt` in every exported game. See [Publishing](../../publishing/index.md#what-the-game-contains).
- The text is long. Show it in a scrolling [2D Scroll Box](../../components/2d-scroll-box.md) with [2D Rich Text](../../components/2d-rich-text.md) or [2D Text](../../components/2d-text.md).
- It works in Play, Preview Build and exported games.
