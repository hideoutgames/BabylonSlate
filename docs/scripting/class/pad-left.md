---
node: string.padLeft
---

# Pad Left

Adds characters before a string until it reaches a length.

## Inputs

| Pin | Type | Description |
| --- | --- | --- |
| String | String |  |
| Length | Integer | Defaults to 0. |
| Pad Character | String | Defaults to a space. |

## Outputs

| Pin | Type |
| --- | --- |
| Return Value | String |

## Notes

- "7" padded to 3 with "0" returns "007". A string already that long is unchanged.
- An empty **Pad Character** pads with spaces.
