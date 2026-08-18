# Performance budget — A16 iPad baseline

Target device: **11-inch A16 iPad**, 6 GB RAM, WebGL2, WKWebView. Desktop builds inherit headroom.

## Frame and tick

| Metric | Budget | Notes |
| --- | --- | --- |
| Play / interaction | project `playFrameCap` (default 60) | Caps Play/Preview from Project Settings; overlay has no live cap field. P4 e2e does not prove A16 60fps — CI tick budget is `p14-perf-smoke`; device 60fps stays `p1-device-spikes` |
| Visible editor viewport | Engine Settings frame cap (default 30) | Scene + Prefab Preview while on screen |
| Hidden / modal / Play / background | **0 rendered frames** | Freeze the editor loop (§2.4) |
| Warm non-CB document workspaces | **≤ 3** | Active chrome tab + 2 recent (`MAX_WARM_DOCUMENT_WORKSPACES`). Content Browser always mounted |
| Idle inactive chrome tab | Unmount after **2 min** | `DOCUMENT_IDLE_UNMOUNT_MS`; pause clock while app backgrounded |
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
- Shadow maps default 1024. Authored post-process stacks default to empty. Engine Settings `postProcessingEnabled` defaults **on** and can skip attaching those stacks in the editor / Play preview without changing the scene or exported games.
- Pause render loop, game worker, and encode queue on `visibilitychange` / app background.
- Visible editor viewports always render at `viewportFrameCap` (default 30); freeze when hidden (zero-size or fully off-screen), obstructed, or a modal is open. IntersectionObserver plus an on-screen rect fallback; continuous-render leases stay refcounted.
- Idle-unmount inactive chrome-tab workspaces after 2 minutes (`p18-inactive-documents`); cap 3 warm non-CB DockViews. P4 freeze is not a substitute for unmount. Remount restores layout / camera / graph viewport.
- Content Browser **grid** is window-virtualised (`p18-content-browser-virtualize`); TreeView already is. Revoke off-screen thumbnail blob URLs.
- Add Node catalog **body** is window-virtualised (`p18-add-node-virtualize`); category sidebar stays unwindowed. Distinct from canvas `p18-graph-virtualize`.
- One `Engine` for editor viewport, Play overlay, Material Preview, UI designer, **and Prefab Preview** (`p18-shared-prefab-engine`).
- Play/Preview renders at project `playFrameCap` (default 60), not the editor viewport cap.
- Construct textures only through `ResourceCache` (stable blob URL + canonical sampling flags).
- No per-actor per-frame allocation in snapshot apply (reuse scratch math objects).


## CI

`p14-perf-smoke` is in `pnpm verify` (Vitest):

- Tiny in-process scene: `lastScriptMs`, `lastPhysicsMs`, and combined tick `< TICK_BUDGET_MS` (8 ms). Keep the fixture small so GitHub runners stay under budget.
- Accounted texture + geometry bytes vs committed ceilings (`TEXTURE_BYTE_CEILING` 512 MB, `GEOMETRY_BYTE_CEILING` 128 MB). Drift fails CI.
- Obstructed / hidden editor: `RenderScheduler.shouldRender() === false` (zero frames).
- Draw-call ceiling (`DRAW_CALL_WARN_CEILING` 400) as HUD warnings.

A16 60fps and on-device reopen remain `p1-device-spikes`. Export unzip-serve-boot-tick is `e2e/p14-export.spec.ts`.
