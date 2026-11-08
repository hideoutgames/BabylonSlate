---
node: system.getLocale
---

# Get Locale

Returns the player's language and region.

## Outputs

| Pin | Type | Description |
| --- | --- | --- |
| Locale | String | The language and region, such as `en-US` or `pt-BR`. |
| Language | String | The language alone, in lower case, such as `en` or `pt`. |

## Notes

- Comes from the browser or device language settings.
- Use **Language** to pick translated text, and **Locale** when the region matters, such as for date formats.
