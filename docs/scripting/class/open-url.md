---
node: system.openUrl
---

# Open URL

Opens a web address in a new browser tab.

## Inputs

| Pin | Type | Description |
| --- | --- | --- |
| In | Exec |  |
| URL | String | A full address starting with `https://` or `http://`. |

## Outputs

| Pin | Type |
| --- | --- |
| Out | Exec |

## Notes

- Only `http` and `https` addresses open. Anything else writes a warning to the **Output Log** and does nothing.
- Browsers block new tabs unless the player has just tapped or clicked, so run it from a button.
- When the browser blocks it, nothing opens and the game continues.
- In the Haptic desktop app, Play and Preview Build open only Haptic's own pages. Test other addresses in the web editor or an exported game.
