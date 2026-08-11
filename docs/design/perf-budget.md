# Performance budget — A16 iPad baseline

Target device: **11-inch A16 iPad**, 6 GB RAM, WebGL2, WKWebView. Desktop builds inherit headroom.

## Frame and tick

| Metric | Budget | Notes |
| --- | --- | --- |
| Play / interaction | 60 fps native refresh | Dynamic resolution scaling before frame drops |
| Idle editor | **0 rendered frames** | Dirty-driven viewport (§2.4) |
| Game tick (combined) | &lt; 8 ms | ~5 ms scripts + ~3 ms physics in one worker |
| Draw calls | Low hundreds | Prefer instancing; surface in stats HUD |

## Memory

| Resource | Budget | Notes |
| --- | --- | --- |
| Editor + project open | ~512 MB textures accounted | WKWebView kills tab rather than swapping |
| Texture accounting | Self-computed bytes | No `performance.memory` on Safari |

Bytes per texel (unit-tested): RGBA8 = 4, ASTC 4×4 = 1, plus ~⅓ for mipmaps.

## Render rules (agents)

- `adaptToDeviceRatio: false`; resolution via `setHardwareScalingLevel`.
- MSAA off on iPad baseline.
- `skipPointerMovePicking: true` on all scenes (touch has no hover).
- Shadow maps default 1024; post-processing off by default.
- Pause render loop, game worker, and encode queue on `visibilitychange` / app background.

## CI

P14 adds perf smoke: fixed scene, tick under budget, idle editor zero frames, accounted bytes ceiling.
