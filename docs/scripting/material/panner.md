---
node: texture.panner
---

# Panner

Scrolls UV coordinates at a steady speed.

## Inputs

| Pin | Type | Default | Description |
| --- | --- | --- | --- |
| UV | Vector2 |  | Where to start from. When unconnected, uses the mesh UV, the particle UV or [**Screen UV**](screen-uv.md), depending on the material's domain. |
| Speed | Vector2 | (0.1, 0) | How far the UV moves each second on each axis. |
| Time | Float |  | The clock to scroll by. When unconnected, uses the game's [**Time**](time.md). |

## Outputs

| Pin | Type |
| --- | --- |
| Out | Vector2 |

## Notes

- Returns UV + Speed x Time.
- Connect Out to **UV** on [**Texture Sample**](texture-sample.md) to scroll a texture.
- Wire your own Time to pause, reverse or change the pace of the scroll.
