# Render sync and resource cache (P4)

Main-thread Babylon view owned by `@babylonslate/render` (engineplan §2.1, §2.4).

## App-lifetime Engine

One `Engine` for the editor process. Editor viewport and Play each own a `Scene`. Play binds its canvas with `registerView` / `unRegisterView` — never a second `Engine` (WebGL context caps).

## Snapshot apply

- Interpolate between the two most recent stable bridge snapshots.
- Reuse scratch `Vector3` / `Quaternion` / `Matrix`; no per-actor per-frame allocation.
- Bulk apply / despawn wrapped in `blockMaterialDirtyMechanism` and `blockfreeActiveMeshesAndRenderingGroups`.
- `skipPointerMovePicking: true` on every scene.

## Render-on-demand

Dirty-driven editor loop: early-return unless invalidated. Continuous-render leases are refcounted. Invalidation sources: snapshot arrival, camera, selection, asset reload, Play. Dev Always Render toggle; HUD exposes rendered-fps vs invalidations/sec.

`adaptToDeviceRatio: false`; resolution via `setHardwareScalingLevel`. Pause render loop, game worker, and encode queue on background.

## Resource cache

LRU with byte ceiling (~512 MB accounted) plus refcounts. Stable blob URL per asset guid for app lifetime; one canonical sampling-option set so engine-level `InternalTexture` dedupe hits across editor and Play scenes.

Cache key includes `url`, `noMipmap`, `samplingMode`, `invertY`, `useSRGBBuffer`, `isCube`. Constructing `Texture` outside the cache is lint-banned.

Self-computed bytes: RGBA8 = 4 B/texel, ASTC 4×4 = 1, plus ~⅓ for mipmaps. Context-loss restore drops one quality tier and flushes the LRU.

Invariant: Play open-and-close must not grow `engine.getLoadedTexturesCache().length`.

See [bridge.md](bridge.md) for the snapshot wire format and [perf-budget.md](../design/perf-budget.md) for budgets.
