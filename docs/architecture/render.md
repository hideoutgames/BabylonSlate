# Render sync and resource cache (P4)

Main-thread Babylon view owned by `@babylonslate/render` (engineplan §2.1, §2.4).

## App-lifetime Engine

One `Engine` for the editor process. Editor viewport and Play each own a `Scene`. Play binds its overlay canvas with `registerView(canvas, undefined, true)` / `unRegisterView` — never a second `Engine` (WebGL context caps).

`registerView` does not give Play its own WebGL context. Babylon renders into the editor canvas and **2D-blits** that bitmap onto the overlay. `clearBeforeCopy: true` clears the overlay before each copy so skipped or resized frames cannot composite additively (ghosting). `dispose()` calls `engine.stopRenderLoop` with the same callback `runRenderLoop` registered, so Play open/close does not accumulate loops on the shared Engine.

Play does **not** seed `createDefaultScene()` (the default Cube). The Play scene is camera + light only; snapshot apply then creates proxy boxes for runtime actors. Stacking the default Cube under those proxies at the origin z-fights and looks like a double draw. Authored `SerializedScene` load in Play is still `p7-play-scene-load`.

Play takes a `acquireContinuous("play")` lease for the session so every overlay blit is preceded by `scene.render()`. The editor stays dirty-driven; `syncEditorPlayState(handle, playing)` pauses it while Play is open and on close resizes (undoing Play’s `setSize`) and invalidates so the docked viewport redraws.

## Snapshot apply

- Interpolate between the two most recent stable bridge snapshots.
- Reuse scratch `Vector3` / `Quaternion` / `Matrix`; no per-actor per-frame allocation.
- Bulk apply / despawn wrapped in `blockMaterialDirtyMechanism` and `blockfreeActiveMeshesAndRenderingGroups`.
- `skipPointerMovePicking: true` on every scene.

## Render-on-demand

Visible editor canvases (scene viewport and Prefab Preview) render at Engine Settings `viewportFrameCap` (Always Render default on). Freeze — skip `scene.render()` — when the canvas is not intersecting / zero-size, a dialog/alert/sheet overlay is open, Play is up, or the app is backgrounded. Dirty-driven invalidation and refcounted continuous-render leases remain the Always Render-off path and still honor the same frame cap. Play views hold an `acquireContinuous("play")` lease for the session so the overlay blit always follows a real `scene.render()`. HUD exposes rendered-fps vs invalidations/sec.

`adaptToDeviceRatio: false`; resolution via `setHardwareScalingLevel`. Pause render loop, game worker, and encode queue on background.

The dynamic resolution valve (`HardwareScalingController.noteFrameTime`) is fed the cost of `scene.render()` itself, timed immediately around that call — never the wall-clock gap since the previous rendered frame. A frozen obstructed viewport can leave that gap at seconds; feeding the idle gap in would read as a catastrophic frame time on the next render and drop quality for no reason.

## Resource cache

LRU with byte ceiling (~512 MB accounted) plus refcounts. Stable blob URL per asset guid for app lifetime; textures resolve only via `ResourceCache.getTexture()` with one canonical sampling-option set so engine-level `InternalTexture` dedupe hits across editor and Play scenes.

Cache key includes `url`, `noMipmap`, `samplingMode`, `invertY`, `useSRGBBuffer`, `isCube`. Constructing `Texture` outside the cache is lint-banned.

Self-computed bytes: RGBA8 = 4 B/texel, ASTC 4×4 = 1, plus ~⅓ for mipmaps. Context-loss restore drops one quality tier and flushes the LRU.

Invariant: Play open-and-close must not grow `engine.getLoadedTexturesCache().length` (asserted in Play stop + unit cache cycle).

## Picking

`skipPointerMovePicking: true` (no hover). Explicit taps use `pickAtCanvas` / `EngineHandle.pickAt`.

## Lifecycle pause

`visibilitychange` (and Capacitor app-state when present) pauses the render scheduler, game worker / in-process runtime tick, and texture encode queue. Encode pause uses a reason set (`visibility` | `play`) so ending Play does not resume encoding while the tab is still hidden.

Editor canvases also freeze when not intersecting or when a blocking overlay (`dialog-overlay`, `alert-dialog-overlay`, `sheet-overlay`) is open. Scene and Prefab Preview both register with the editor scheduler registry so Always Render and pause apply to whichever canvas is alive.

## Editor tools (P6)

Editor viewport attaches these modules from `@babylonslate/render` (Play views omit them):

| Module | Role |
| --- | --- |
| `editor-camera` | Mode-parametric ArcRotate controller; 2D ortho pan/zoom, pixel-perfect framing |
| `gizmo-host` | Translate / rotate / scale on a utility layer; axis set filtered by `ViewportMode` |
| `editor-grid` | 3D XZ or 2D XY grid; tile spacing + subdivisions; `cameraBounds2D` overlay |
| `selection-outline` | Highlight mesh(es) for selected actors |
| `editor-scene-sync` | Incremental apply of `SerializedScene` to Babylon meshes |
| `viewport-gestures` | Two-finger orbit/pan/zoom; 2D one-finger marquee; tap pick |
| `sorting` / `pixel-perfect` | 2D sort keys via `alphaIndex`; PPU-driven ortho bounds, pixel-grid snap, and `applyPixelArtSamplingToScene` when pixel-perfect is on |

**Invalidation wiring**: `RenderScheduler.invalidate(reason)` — editor tools call `"camera"`, `"gizmo"`, and `"selection"`; scene sync uses `"asset"`. Gizmo drags acquire a continuous-render lease (`acquireContinuous("gizmo")`). See [scene-editing.md](scene-editing.md).

See [bridge.md](bridge.md) for the snapshot wire format and [perf-budget.md](../design/perf-budget.md) for budgets.
