---
node: color.blendOverlay
---

# Blend Overlay

Darkens the dark parts of Base and lightens the light parts by Blend, as the Overlay blend mode of an image editor does.

## Inputs

| Pin | Type | Default |
| --- | --- | --- |
| Base | Any | 0.5 |
| Blend | Any | 0.5 |

## Outputs

| Pin | Type |
| --- | --- |
| Out | Any |

## Notes

- Where Base is below 0.5 it returns 2 x Base x Blend, elsewhere 1 - 2 x (1 - Base) x (1 - Blend).
- Mid grey (0.5) in Blend leaves Base unchanged.
- Each channel is blended separately.
