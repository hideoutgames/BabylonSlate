# Performance budget — A16 iPad baseline

Target device: **11-inch A16 iPad**, 6 GB RAM, WebGL2, WKWebView. Desktop builds inherit headroom.

## Frame and tick

| Metric | Budget | Notes |
| --- | --- | --- |
| Play / interaction | project `playFrameCap` (default 60) | Caps Play/Preview from Project Settings; overlay has no live cap field |
| Visible editor viewport | Engine Settings frame cap (default 60) | Scene + Prefab Preview while on screen |
| Hidden / modal / Play / background | **0 rendered frames** | Freeze the editor loop (§2.4) |
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
- Visible editor viewports render at `viewportFrameCap`; freeze when hidden (zero-size or fully off-screen), obstructed, or a modal is open. IntersectionObserver plus an on-screen rect fallback; dirty-driven idle is the Always Render-off path; continuous-render leases stay refcounted.
- Play/Preview renders at project `playFrameCap` (default 60), not the editor viewport cap.
- Construct textures only through `ResourceCache` (stable blob URL + canonical sampling flags).
- No per-actor per-frame allocation in snapshot apply (reuse scratch math objects).


## CI

P14 adds perf smoke: fixed scene, tick under budget, obstructed editor zero frames, accounted bytes ceiling.
