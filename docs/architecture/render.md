# Render sync and resource cache (P4)

Main-thread Babylon view owned by `@babylonslate/render` (engineplan §2.1, §2.4, §2.5).

## App-lifetime Engine

One `Engine` for the editor process. Editor viewport and Play each own a `Scene`. Play binds its overlay canvas with `registerView(canvas, undefined, true)` / `unRegisterView` — never a second `Engine` (WebGL context caps). The UserInterface designer uses the same shared Engine: `createUiSurface` builds a dedicated Scene + standalone `CreateFullscreenUI` (`@babylonjs/gui` is a `@babylonslate/render` dependency only) and **copies the ADT Canvas2D** onto the document canvas (`presentAdtToCanvas` throws if the 2D context or backing store is missing; a 0×0 ADT size is skipped). Hidden Design / live EditorUtilityInterface tabs call `setFrozen(true)` so those copies (`present`, `markDirty`, pointer picks) skip. It does not `registerView` that canvas — extra views blit the last 3D framebuffer (editor / Play) onto the tab. Play HUD is a foreground ADT Layer on the Play scene (`attachFullscreenGui`). Dispose the designer Scene + ADTs when the document tab closes so Play’s texture-cache invariant still holds.

**Dockview GUI host (P12):** EditorUtilityInterface **live** tabs (`p12-editor-extensions`) are Dockview panels, not the designer. They use the same ADT-copy path inside a Dockview tab (resize with the panel, freeze when the tab is hidden, dispose on close). Do not `registerView` a utility canvas. UserInterface and EditorUtilityInterface **authoring** uses that same surface on the Design dock tab (`p12-ui-editors`).

## Game UI apply (Babylon-native)

UserInterface documents store Babylon GUI fields (alignment, px/%, left/top, layout padding, transform center). `packages/render` copies those fields onto nested controls — there is no RectTransform solver and no letterbox math in the Play path.

- **ADT bitmap** is the device/canvas size. **ADT ideal** (`idealWidth` / `idealHeight` / `useSmallestIdeal`) is `document.designResolution` + `scaleRule` via `applyAdtIdeal`. Resize must not overwrite ideal with the bitmap size.
- **Parenting is 1:1 with the widget tree.** Only roots go on the texture host. HorizontalBox/VerticalBox → `StackPanel`; Grid → `Grid` (`addControl(child, row, col)`); ScrollBox → `ScrollViewer`. Never `adt.addControl` for non-roots.
- **SafeArea** is a host-injected `Container` (`__safeArea`) under the root Canvas, padded from the device-preset insets. Default Canvas children parent into it; `ignoreSafeArea` parents to the full-bleed canvas.
- **TouchDPad** is a `Rectangle` plus composed `Ellipse`s; TouchButton is a `Rectangle`. Slider `min` / `max` copy onto the Babylon slider. Unspecified text color is `#ffffff`; TouchJoystick without a background is `#e5e5e5` (not opaque black). Canvas fill is authored only.
- **Fonts:** `applyFontRegistryToHost` (`registerAll` then `consumeDirty` → `adt.markAsDirty()`) on Play HUD and the designer ADT so a custom face is dirty on the first frame after load.

`ui-runtime` stays Babylon-free: it validates the GUI fields, migrates legacy RectTransform payloads (schema v2), and builds the nested spec. A `previewRect` helper mirrors Babylon’s published alignment/%/padding formulas for jsdom designer hit-tests; when a live Engine exists the designer prefers ADT `widthInPixels` / `centerX` bounds.

See [ui-runtime.md](ui-runtime.md) and [fonts.md](fonts.md). Agents applying Babylon GUI (UserInterface or EditorUtilityInterface) follow [`.cursor/skills/BabylonJS/SKILL.md`](../../.cursor/skills/BabylonJS/SKILL.md).

`registerView` does not give Play its own WebGL context. Babylon renders into the editor canvas and **2D-blits** that bitmap onto the overlay. `clearBeforeCopy: true` clears the overlay before each copy so skipped or resized frames cannot composite additively (ghosting). Play also sets `scene.autoClear = true` after `ScenePerformancePriority.Intermediate` (that priority otherwise disables color-buffer clear, which trails when there is no skybox). Authored `settings.environmentColor` is the Play `clearColor` when the session has a scene payload. `dispose()` calls `engine.stopRenderLoop` with the same callback `runRenderLoop` registered, so Play open/close does not accumulate loops on the shared Engine.

Play does **not** seed `createDefaultScene()` (the default Cube) into the Play Babylon scene. The Play scene is camera + light only; snapshot apply creates meshes for runtime actors. `assignMesh` commands carry `meshKind` from `MeshComponent` so Play primitives match the editor (sphere, box, …) instead of always being a unit box. Authored actors themselves come from the `load` message `scene` payload (`p7-play-scene-load`).

Play takes a `acquireContinuous("play")` lease for the session so every overlay blit is preceded by `scene.render()`. The editor stays dirty-driven; `syncEditorPlayState(handle, playing)` pauses it while Play is open and on close resizes (undoing Play’s `setSize`) and invalidates so the docked viewport redraws.

Play overlay canvas layout comes from Project Settings. When `render.customResolution` is on (new projects default **1920×1080**, `blackBars` off = stretch), Play calls `engine.setSize(width, height)` so the framebuffer is exactly WxH. Black bars off: CSS stretch (`width/height 100%`, `object-fit: fill`). Black bars on: uniform contain via `fitContainedRect` and overlay `bg-black`. The overlay ResizeObserver must **not** call `engine.resize()` while that size is locked — that would undo `setSize`. On Play close, `syncEditorPlayState` restores editor size. `ctx.setRenderResolution(width, height)` emits a `setRenderResolution` command and overrides WxH for the session only (does not write `project.json`). When custom resolution is missing or off, **Follow System** (default on existing projects) fills the overlay; when Follow System is off, the canvas is the largest centered rectangle of `aspectWidth:aspectHeight` (default 16:9) with unused overlay space black. Editor viewports and Prefab Preview stay fill-the-panel. Export will consume the same game render size when `packages/exporter` lands.

## Snapshot apply

- Interpolate between the two most recent stable bridge snapshots.
- Reuse scratch `Vector3` / `Quaternion` / `Matrix`; no per-actor per-frame allocation.
- Bulk apply / despawn wrapped in `blockMaterialDirtyMechanism` and `blockfreeActiveMeshesAndRenderingGroups`.
- `skipPointerMovePicking: true` on every scene.
- `applyAssignMesh` records `meshKind`, `meshAssetGuid`, and optional `parts[]` per slot and rebuilds the Play mesh via `createPlayMesh`. A single identity visual stays `actor-<slotId>` (snapshot-driven). Multiple or offset parts keep that name as a hidden origin and parent `actor-<slotId>|<componentId>` children at local TRS; picking walks parents to the origin. `meshKind: "sprite"` / `"tilemap"` build quads/chunks and bind `ResourceCache` textures from collected `textureBytes` with the sprite alpha-test material (`alphaCutOff` 0.4). Tilemap chunk children apply per-layer sorting and parallax; animated tiles are a sibling `:anim` mesh. When `twoD.pixelPerfect` is on, snapshot apply snaps the **Play** camera XY to the pixel grid. `MeshComponent.assetGuid` with model bytes builds the first GLB primitive instead of a box. `meshKind: "light:*"` / `"camera"` create detached authored lights/`UniversalCamera`s; `assignMesh.light` / `.camera` apply color, intensity, range, cone, enabled, projection, FOV, clips, and Default Camera (`isDefault`). Missing Default Camera keeps the Play viewport camera named `"camera"` — it does not steal the first CameraComponent. `possessCamera` switches the global Play `activeCamera`; `setShadowQuality` sizes the one `ShadowGenerator`.
- `animState` with `clipKind: "sprite"` bakes clip UVs through `applySpriteAnimFrame` when `createEngine({ spritePayloads })` has the sprite asset for that guid.
- Editor and Play pass `setMeshAssets` / `CreateEngineOptions.textureBytes` + `modelBytes` collected from scene component guids (`pixels` then `source` for textures; `source` for models).

## Render-on-demand

Visible editor canvases (scene viewport and Prefab Preview) render at Engine Settings `viewportFrameCap` (Always Render default on). Freeze — skip `scene.render()` — when the canvas is zero-size or fully off-screen, a dialog/alert/sheet overlay is open, Play is up, or the app is backgrounded. IntersectionObserver is the fast path; if it reports not intersecting, a window-overlap `getBoundingClientRect` check still keeps an on-screen canvas visible (iOS standalone IO is unreliable under Dockview CSS transforms). Dirty-driven invalidation and refcounted continuous-render leases remain the Always Render-off path and still honor the same frame cap. Play views hold an `acquireContinuous("play")` lease for the session so the overlay blit always follows a real `scene.render()`, and they use the project `playFrameCap` (default 60) rather than the editor viewport cap. The cap is applied when Play starts from Project Settings `playFrameCap`. The overlay HUD shows FPS / script / physics and does not change the cap live. HUD exposes rendered-fps vs invalidations/sec.

`adaptToDeviceRatio: false`; resolution via `setHardwareScalingLevel`. Pause render loop, game worker, and encode queue on background.

The dynamic resolution valve (`HardwareScalingController.noteFrameTime`) is fed the cost of `scene.render()` itself, timed immediately around that call — never the wall-clock gap since the previous rendered frame. A frozen obstructed viewport can leave that gap at seconds; feeding the idle gap in would read as a catastrophic frame time on the next render and drop quality for no reason.

## Resource cache

LRU with byte ceiling (~512 MB accounted) plus refcounts. Stable blob URL per asset guid for app lifetime; textures resolve only via `ResourceCache.getTexture()` with one canonical sampling-option set so engine-level `InternalTexture` dedupe hits across editor and Play scenes.

Cache key includes `url`, `noMipmap`, `samplingMode`, `invertY`, `useSRGBBuffer`, `isCube`. `getTexture(..., { isCube: true })` returns a `CubeTexture` (IBL). Constructing `Texture` outside the cache is lint-banned.

Self-computed bytes: RGBA8 = 4 B/texel, ASTC 4×4 = 1, plus ~⅓ for mipmaps. Context-loss restore drops one quality tier and flushes the LRU.

Invariant: Play open-and-close must not grow `engine.getLoadedTexturesCache().length` (asserted in Play stop + unit cache cycle).

## Picking

`skipPointerMovePicking: true` (no hover). Explicit taps use `pickAtCanvas` / `EngineHandle.pickAt`.

## Lifecycle pause

`visibilitychange` (and Capacitor app-state when present) pauses the render scheduler, game worker / in-process runtime tick, and texture encode queue. Encode pause uses a reason set (`visibility` | `play`) so ending Play does not resume encoding while the tab is still hidden.

Editor canvases also freeze when zero-size or fully off-screen, or when a blocking overlay (`dialog-overlay`, `alert-dialog-overlay`, `sheet-overlay`) is open. Visibility uses IntersectionObserver plus an on-screen rect fallback so a lying iOS IO under Dockview transforms does not skip frames. Scene and Prefab Preview both register with the editor scheduler registry so Always Render and pause apply to whichever canvas is alive.

## Editor tools (P6)

Editor viewport attaches these modules from `@babylonslate/render` (Play views omit them):

| Module | Role |
| --- | --- |
| `editor-camera` | Mode-parametric ArcRotate controller; 3D look-in-place + fly, 2D ortho pan/zoom, pixel-perfect framing. `setMode` snapshots the current pose and restores the other mode's last in-session framing (not written to the scene document). `exportSessionState` / `importSessionState` round-trip both mode slots as plain numbers so a remounted viewport (Focus exit, Windows reopen) can restore the view. |
| `gizmo-host` | Translate / rotate / scale on a utility layer; unlit axis materials (`GIZMO_AXIS_COLORS` / `GIZMO_UNIFORM_COLOR`); `scaleRatio` 1.8; thin shafts with larger end caps; leaf colliders scaled 2.5× (rotation rings 8×) for touch; `ScaleGizmo.sensitivity` 10; planar handles; hover; axis set filtered by `ViewportMode`; `hitTest` / `isDragging` block camera look |
| `editor-grid` | World-aligned shader plane (3D XZ / 2D XY) that follows the editor camera; tile spacing + subdivisions; `cameraBounds2D` overlay. Fragment shader is GLES 1.00 (`fwidth` AA) without `GL_OES_standard_derivatives` so WebGL2 compile succeeds. |
| `selection-outline` | Highlight mesh(es) for selected actors |
| `editor-scene-sync` | Incremental apply of `SerializedScene` to Babylon meshes. Multi/offset visuals use a hidden origin root; gizmo stays on `actor.transform`. |
| `scene-illumination` | Incremental `authoredLight:<actorId>` / `authoredCamera:<actorId>` maps. Direction is (actor rotation × component rotation) × Babylon forward `(0,0,1)`. Position is actor TRS × Light/Camera `component.transform`. Game cameras are detached `UniversalCamera` (never ArcRotate). Editor keeps the orbit camera (`stealActiveCamera: false`) unless Viewport **Game Camera** preview is on. Play uses the named Default Camera; missing keeps the Play default. Default hemi dims when any authored light exists. One `ShadowGenerator` on the first `castShadows` light, sized from `shadowquality` (`off`/`512`/`1024`/`2048`). Linear fog + optional IBL cube; `environmentColor` is Play and 3D-editor clear (2D editor keeps chrome clear). Contract: [engineplan §2.5](../engineplan.md). |
| `editor-billboard` | Camera-facing unlit icon quads for Light / Camera / Audio so they stay pickable. On a wrapped origin actor they are component children; a lone identity billboard is still the actor mesh. Play does not `assignMesh` these; authored lights/cameras come from `scene-illumination`. |
| `editor-debug-overlay` | Selected `CameraComponent`: dashed frustum lines + 320×180 `RenderTargetTexture` ticked at 1 Hz (not the 60 fps loop), blitted into a corner `data-testid="camera-preview"` canvas. Selected `LightComponent`: dashed point rings, spot cone, or directional arrow from `range` / `outerAngle`. Same overlay in the scene viewport and Prefab viewport. Does not replace the editor hemispheric fill light. |
| `viewport-gestures` | 3D one-finger look, 2D one-finger pan 1:1 with the pointer (hold-then-move marquee), Drag Select immediate marquee in both modes, pinch zoom, three-finger pan (2D same 1:1 scale; 3D `panScale`); tap pick |
| `viewport-fly-keys` | WASD fly/pan with rAF + continuous-render lease |
| `sorting` / `pixel-perfect` | 2D sort keys via `alphaIndex`; PPU-driven ortho bounds, pixel-grid snap, and `applyPixelArtSamplingToScene` when pixel-perfect is on. Editor pinch/wheel zoom is continuous (integer zoom steps do not snap the frustum). |

**Invalidation wiring**: `RenderScheduler.invalidate(reason)` — editor tools call `"camera"`, `"gizmo"`, and `"selection"`; scene sync uses `"asset"`. Gizmo drags, viewport gestures, WASD fly, and the editor joystick acquire continuous-render leases. See [scene-editing.md](scene-editing.md).

See [bridge.md](bridge.md) for the snapshot wire format and [perf-budget.md](../design/perf-budget.md) for budgets.
