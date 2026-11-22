---
node: render-target.getMode
---

# Get Render Target Mode

Returns what a Render Target records: Scene Color, Depth Pass or World Normal.

## Inputs

| Pin | Type |
| --- | --- |
| Render Target | RenderTarget Asset |

## Outputs

| Pin | Type |
| --- | --- |
| Mode | RenderTargetMode |

## Notes

- The Render Target loads with the object that runs this node, so its mode is ready at once.
- A missing asset returns Scene Color.
