# Engine Plan

Authoritative product and architecture plan for Haptic: goals, non-goals, binding decisions with their reasons, open work and deliberate behaviour.

- The product is **Haptic**. Code identifiers are not renamed yet: keep `@haptic/*`, `.hasset` / `.hplugin` / `.htrace` / `.hextension`, `BL_*` env vars and `haptic:` URLs verbatim.
- Package map, data flow and contributor rules: [architecture.md](architecture.md). Per-subsystem notes: [architecture/](architecture/). Import boundaries: `no-restricted-imports` in `eslint.config.js`.
- When this file and the code disagree, the code wins; fix this file in the same change.

## Overview and goals

A touch-first Babylon.js game engine and editor whose baseline is an 11-inch A16 iPad. Goals:

- A worker runtime that keeps physics beside game logic, so a raycast answers on the execution pin that asked.
- Self-contained `.hasset` files in a plain project folder; a compressed KTX2 texture pipeline; a visibility-gated, byte-accounted renderer sized to the iPad memory and thermal ceiling.
- Unreal-style visual scripting compiled to JavaScript, validated continuously, with a post-Preview error report that navigates back to the offending node.
- Homepage and project browser, per-document undo, touch + gamepad + keyboard/mouse input.
- 3D and 2D as flagship modes sharing one scene graph and a viewport toggle; tilemaps and a dedicated 2D physics backend.
- Behaviour trees authored in React Flow over a Recast navmesh shared by 2D and 3D.
- Git LFS file locking for collaboration (sync stays in an external git client); web-only game export.
- Built and maintained by parallel autonomous agents: narrow package boundaries, deterministic tests, goldens, automated review.

Shipped systems beyond the core (do not rebuild): Save Games (typed definitions, separate preview/player storage), `MovementComponent`, Scene streaming (`SceneStreamingActor`), SceneLayers (2D overlay documents), Game/Scene Subsystems, Design / Landscape / Foliage scene modes, Water, Render Targets, lattice `DeformerComponent`, automatic Model LOD, Data Definitions / Data Trees, Tags, Editor Extensions, PBR or native CEL project rendering.

## Non-goals

- No multiplayer or networking of any kind.
- Games export to **web only**. Capacitor (iPad, Android) and Electron (desktop) shells run the *editor*, not games.
- No native code plugins; plugins are content and classes.
- One parent world Scene and one physics world at a time. Streaming adds owned instances beneath it; SceneLayers are a separate overlay stack.
- No live property editing of authored content while playing (stop, edit, play). Simulate edits runtime objects only; authored documents stay read-only until it stops.
- No asset marketplace or remote asset fetching.
- The engine is not a git client: Git LFS locking only.
- Undo does not cover asset file creation or deletion; those are confirmed instead.
- No game HUD / UserInterface / widget system (removed; see Asset type catalog).

## Baseline device and performance budget (rules)

Baseline: 11-inch A16 iPad, 6 GB RAM, WebGL2, WKWebView. Budgets target it; desktop and web inherit headroom.

- Play/Preview renders at project `playFrameCap` (default 60). Dynamic resolution is the relief valve before frame drops.
- A **visible** editor viewport (Scene, Prefab Preview) renders continuously at Engine Settings `viewportFrameCap` (default 30). Hidden, zero-size, obstructed, modal-covered, backgrounded or Play-paused viewports render **zero** frames. Never dirty-skip a visible viewport.
- Game tick under 8 ms combined (~5 ms script, ~3 ms physics), timed separately even though one worker runs both. An overrun lags logic; the renderer keeps drawing the latest snapshot.
- Draw calls in the low hundreds (HUD warns at 400). Prefer instancing and merged static geometry.
- Memory is accounted, not measured (Safari has no `performance.memory`, the web has no pressure event). Defaults: texture budget 2 GB with unreferenced-LRU trim to 80%; decoded audio 256 MiB LRU plus 32 voices; geometry warns at 512 MB (HUD only, not an LRU). Smaller iPad figures appear in settings copy as suggestions only. Constants: [perf-ceilings.ts](../../packages/render/src/perf-ceilings.ts), [stats.ts](../../packages/debugger/src/stats.ts).
- WebGL2 is the default GPU backend; WebGPU is opt-in and must fall back.
- CI enforces only stats cadence, zero frames when obstructed and the draw-call warning. The 8 ms tick and byte ceilings are runtime HUD reports. A16 60 fps is unproven on hardware.
- Desktop or SwiftShader numbers are not A16 qualification; do not quote device savings without a device profile.

## Target architecture

### Threading model

- Main thread: React editor UI, the Babylon renderer (editor and Play views), the bridge host. Game worker: fixed-step scheduler, World, compiled scripts, physics, navigation queries and crowd, Animation Graph and behaviour-tree evaluators. The runtime also runs in-process so tests drive it deterministically without workers.
- Two transport classes. Hot transforms use a double-buffered `Float32Array`: `SharedArrayBuffer` + `Atomics` seq-lock when `crossOriginIsolated`, else transferable ping-pong (the worker currently always transfers; at most two pose snapshots in flight). Structural changes (spawn, despawn, mesh/material assignment, audio, particles) use a reliable ordered message channel, never the snapshot buffer.
- Cross-origin isolation is not guaranteed (GitHub Pages cannot set COOP/COEP): `coi-serviceworker.js` is vendored in `public/`. SAB is an optimisation, never a requirement; both transports are tested.
- **Physics lives in the game worker** because `LineTrace`, overlaps and sweeps must return on the calling pin; across a worker boundary every one becomes latent. The physics backend interface stays transport-agnostic so a split stays possible. The shared tick budget is the accepted trade.
- Fixed-step logic (default 60 Hz) with catch-up capped at 4 steps; Play draws the latest published snapshot without interpolation.
- One world-space contract: hierarchies compose before snapshots and body updates; physics results convert back to actor-local. Visuals stay hidden until a snapshot supplies their transform.
- No user-visible actor limit: recyclable dense slots and geometrically growing, generation-tagged layouts (256 is only the initial allocation).
- **One `Engine` per open project, many `Scene`s.** Play adds a Scene bound with `registerView(canvas, undefined, true)` and never creates an Engine (WebGL contexts are capped and Play is pressed hundreds of times). Prefab and Material previews draw on the same Engine through RTT + 2D blit. Preview Build's iframe is a separate document with its own Engine and must release it on close.
- Disposal is explicit and refcounted (Babylon does not garbage-collect GPU resources). Tests assert live object counts and `engine.getLoadedTexturesCache()` do not grow across a Play cycle.
- Play physics matches Preview Build: Havok loads lazily from a deployment-base-aware URL; hosts wait for the requested engines and stop with a diagnostic on init failure rather than simulating approximately.
- The editor render loop pauses while Play or Preview Build runs; Play disables docked Scene views for the session and re-enables them on close.

### Monorepo layout

`apps/` (editor, player, desktop, docs), `packages/` (24 packages, mapped in [architecture.md](architecture.md)), `engine-content/` (default skybox, billboards, starter art), `engine-plugins/`, `engine-extensions/`. Old names `shared`, `storage`, `engine`, `graph` are gone. Layering decisions:

- Pure packages (core, assets, edit, object-model, scripting, debugger, graph IRs, input, exporter, source-control, …) import neither React nor Babylon; they hold most engine logic and test fast.
- `assets` owns texture **encoding** (Basis wasm, no Babylon); `render` owns **decoding** (`KhronosTextureContainer2`).
- `physics` hosts Babylon Physics V2 on a worker-local `NullEngine` Scene so `runtime` stays Babylon-free. `navigation` may load Recast wasm but not Babylon.
- Only `vfs` adapters touch Capacitor; platform detection is `getHostPlatform()`.

### Babylon integration constraints

- Babylon is left-handed (X right, Y up, Z into the screen). `scene.useRightHandedSystem` stays `false`; 2D conventions derive from it.
- 3D physics: `HavokPlugin` + `PhysicsAggregate` on a never-rendered worker-local `NullEngine` Scene, stepped through its physics engine, Havok wasm loaded with `locateFile`. `runtime` talks only to `PhysicsBackend`. Bodies never cross threads. 2D uses Rapier (Babylon has no Rapier plugin).
- Movement beside a dynamic Rigid Body steers that body's horizontal velocity and leaves gravity, collisions and impulses to physics (rotation locked); without a Rigid Body, or beside a kinematic one, a character controller moves a kinematic capsule. A static Rigid Body, Nav Agent, Ragdoll, Water Buoyancy or a second Movement stops it.
- Gameplay owns animation time: evaluators run in the worker and send state, normalised time and weights; the main thread seeks explicitly and never lets Babylon auto-advance gameplay animation (replay would break).
- The game HUD / UserInterface system is removed. Editor chrome and debug overlays (Print, Stats) are DOM. SceneLayers are 2D actor documents on a session compositor, not a HUD revival.
- Materials lower to NodeMaterial blocks, not shader source, for WebGL + WebGPU portability; the catalog is a curated view over blocks and composes missing builtins from blocks. `CustomBlock` is a GLSL-only escape hatch with an explicit WebGPU diagnostic. Materials pre-warm at load.
- Particle Graphs are our own IR lowered onto Node Particle blocks; never the NPE UI, snippet server, CDN or Babylon JSON.
- glTF import keeps the original bytes as a chunk plus extracted metadata; the runtime loads through Babylon's loader (the one non-pure importer, deliberately). FBX, OBJ and STL convert to GLB in the editor first.
- The KTX2 transcoder is self-hosted via `KhronosTextureContainer2.URLConfig` and must ship in the editor, player and every export.
- WebGL context loss is normal on iPad: restore resets hardware scaling to the Engine Settings floor, the resolution valve forgets hitch samples, Babylon rebuilds retained resources (the ResourceCache is not flushed), materials invalidate and the Output Log reports it.
- iOS blocks audio until a gesture: both hosts unlock on the first touch, never at load.
- `NullEngine` is the `render` test seam and the production host for worker physics.
- Babylon is pinned to an exact version with a repository patch ([patches/](../../patches/), [pnpm-workspace.yaml](../../pnpm-workspace.yaml)); upgrades re-validate the patch.

### iPad memory and thermal architecture

Memory is a cliff (WKWebView kills the tab, it does not swap); sustained power is a slope (throttling slows the rest of the session).

- **Resolution is the cheapest lever.** The Engine uses `adaptToDeviceRatio: false`; `setHardwareScalingLevel` is the single knob for the editor default, Play quality tier, user preference, `quality resolution` and the dynamic valve (rolling median, hysteresis, cooldown). MSAA stays off on the iPad baseline.
- **One GPU texture per asset across Scenes.** Babylon caches `InternalTexture` per Engine keyed by URL *and* sampling flags, so the ResourceCache owns a stable blob URL per asset guid plus one canonical sampling set. Constructing an asset `Texture` outside the cache is prohibited; renderer-owned `RenderTargetTexture` / `RawTexture` are exempt but account bytes through `beginManagedRenderAllocation`.
- **The ResourceCache is a byte-ceilinged LRU, not only refcounts**: it evicts only unreferenced entries, logs evictions, exists once per Engine (`resourceCacheForEngine`), releases a handle's leases on dispose, and is disposed only at project Engine teardown ([resource-cache.ts](../../packages/render/src/resource-cache.ts)).
- **Catalog reads are bounded at storage.** The registry reads only a validated header prefix; payload chunks load on demand with revision, bounds, length and hash checks.
- **Referenced and required are separate dependency edges.** Loading follows required edges only; a declaration's Loading policy is Soft (Load On Demand, default) or Hard (Load With Owner). Script load handles take Low/Normal/High priority; blocking loads hold the simulation. Headers without dependency metadata are refused, never scanned.
- Content Browser thumbnails are small images generated at import, stored in derived data, decoded lazily, with their own LRU separate from scene resources.
- Large lists are windowed with the repository's arithmetic helper (no virtualizer library): Content Browser grid, Add Node body, Output Log, Compiler Results, SearchDialog pick lists, off-screen graph nodes. Place Actors, Add Component and Settings catalogs and the Global Search result body stay unwindowed.
- Global Search rebuilds when opened (async, chunked, includes open-document JSON); no warm index and no on-disk cache.
- Undo history is capped in entries **and** bytes; snapshot fallbacks record their captured bytes.
- Byte accounting is per uploaded format (RGBA8 = 4 B/texel, ASTC 4×4 = 1, about a third more for mips) and unit-tested; the HUD labels it as accounted bytes.
- Touch has no hover: `skipPointerMovePicking = true` in every world, editor and preview scene, except overlay SceneLayer Play scenes (2D Button hover).
- Play scenes run `ScenePerformancePriority.Intermediate` with `autoClear` restored to `true`. Editor scenes stay `BackwardCompatible` (gizmos need live bounds; never `Aggressive`) and take targeted wins: `freezeWorldMatrix` on static actors, `material.freeze` except open Material tabs, unique-id maps, load-time `forceCompilationAsync`. No active-mesh-queue freeze (the FrameGraph collects its own objects). Bulk snapshot apply runs inside `blockMaterialDirtyMechanism`.
- Shaders compile at load behind the loading UI; the material preview recompiles on a trailing debounce with a manual Render fallback.
- After the first frame, a mid-game shader compile never freezes the picture or pauses the game for something already on screen: a world view (Play, the exported player, Preview Build and the editor's world view) keeps drawing a Material's previous Effect, bound by its own light layout, while a changed variant compiles, so a changed light or shadow shows a few frames late. A frame-setup rebuild (a changed shadow set) is to keep drawing the current setup while the next one prepares. Loading still waits for every variant. Fixed-shape forward lighting is not the fix and stays off. Acceptance is CI only (the compile-hold harness with injected driver models and the real-GL variant swap proof), with no device measurement ([render.md](architecture/render.md#frame-path)).
- Play preparation caches compiled graphs by content hash; Audio source bytes load on the first `playSound`.
- Rendering quality is authored and scalable (Low/Medium/High/Ultra, one resolver; `quality` commands patch the session only). Models get automatic LOD with per-Model opt-out. Texture streaming is out of scope (Babylon 9.29 has no mip streaming API); use Downsample, Editor Texture LOD and the budget.
- No per-actor per-frame allocation in snapshot apply or the runtime tick: reuse scratch math objects and buffers.
- Nothing invisible does work: `visibilitychange` and app-state events pause the render loop, worker tick and encode queue; closed tabs release Babylon resources.
- Document working set ([document-working-set.ts](../../apps/editor/src/lib/document-working-set.ts)): the active tab, Content Browser and open Scene tabs stay mounted; other tabs unmount 2 minutes after last use, at most 3 warm non-Content-Browser workspaces, idle clock paused while backgrounded. Undo stacks and document JSON never drop on unmount; remount restores layout, camera pose and graph view.
- Sprite alpha testing versus blending for fill rate on a dense A16 2D scene is still an unmeasured device question.

### Lighting and cameras

- Lit materials share a bounded per-GPU light capacity; over capacity, selection keeps global lights, explicit priority and nearby lights with hysteresis (excluded light billboards turn yellow). Shadow admission is a separate budget.
- `LightComponent` kinds: point, directional, spot. `HemisphericFillLightComponent` is separate; `AreaRectLightComponent` is world-only and unshadowed. No implicit hemispheric light is planted; PBR with no lights and no IBL is dark by design. Viewport Unlit is a session overlay.
- Direction is actor world rotation × Babylon forward `(0, 0, 1)`; hemispheric fill uses world +Y; scale never aims a light.
- Light/camera sync is incremental (`authoredLight:<actorId>` / `authoredCamera:<actorId>`, updated in place). Play applies the same properties; white Play lights are a bug.
- Shadows are budgeted and camera-relative; one directional light illuminates at a time; helpers, skyboxes and debug overlays never cast or receive.
- Water bodies within the project **Water Blend Distance** merge into one surface through one shared kernel used by rendering and worker queries.
- IBL is optional and off by default (`environmentTextureGuid`). Never auto-generate IBL from a sky; the skybox mesh never writes `scene.environmentTexture`.
- `SkyboxComponent` builds its own box (unlit PBR, `SKYBOX_MODE`, depth writes off, never `infiniteDistance`, never pickable, shadowed or nav geometry). Never call `scene.createDefaultSkybox`. Empty faces use the Engine-owned default cube from `engine-content/skybox`, which Play must not evict ([default-skybox](../../packages/render/src/default-skybox/)).
- New 3D scenes: a locked skybox, a daylight directional sun that meets faces turned to the default camera at cos 0.6 (a grazing sun smears shadow-map edges) and a camera; 2D scenes are camera-only; Blank creates an empty 3D scene.
- `environmentColor` is the clear colour for Play and the 3D editor; the 2D editor keeps the dark chrome clear for grid readability.
- Game cameras are detached `UniversalCamera`s posed from the actor, looking along local +Z; never `ArcRotateCamera` (that stays the editor orbit camera).
- Viewport **Game Camera** pilots the Default Camera actor ([game-camera-pilot.ts](../../packages/render/src/game-camera-pilot.ts)): `EditorTools.navigation` routes look, fly, pan and zoom to the actor's transform, and each input pause commits one undoable edit. No Default Camera actor, a locked one or Play leaves inputs off; the editor orbit camera is never moved.
- Active camera: script **Possess Camera** > valid scene **Default Camera** (stored as actor + component ids) > a camera's `attemptPossessViewTarget` > the default Play camera. Never silently pick the first CameraComponent ([runtime-camera.ts](../../packages/runtime/src/runtime-camera.ts)).
- Lens aspect is the buffer drawn (`applyAuthoredCameraLens`); a 0×0 buffer falls back to 16:9; orthographic half-width = half-height × live aspect. Never stretch with `object-fit: fill`; shared-Engine Play sizes with `setSize`, not `engine.resize()`.
- 2D game cameras are orthographic looking +Z; pixel-perfect snapping applies to the game camera only.
- New scene/component keys are additive and normalize to defaults; bump a schema version only if old documents would mis-parse.
- Out of scope: shadowed area lights, follow/virtual camera rigs, extra viewports, camera stacking.

### Audio

- The imported `Audio` asset is the sound asset (MP3, WAV, OGG; import-only, no separate Sound type). Payload: `volume`, `loop`, nullable `audioChannelGuid` and `soundAttenuationGuid`.
- `AudioChannel` routes and holds effects but has no volume; parent cycles are rejected. `AudioMixer` is a user asset selected in Project Settings (default none). `SoundAttenuation` opts a sound into 3D playback.
- The no-setup path is first-class: no mixer, channel or attenuation still plays at `assetVolume × callVolume`.
- `outputGain = assetVolume × callVolume × channelGain × parentGains… × globalGain`, every factor clamped `0..1`. Set Channel/Global Volume replace session values, never edit assets, and reset on Stop or scene change.
- One main-thread Babylon AudioV2 service in `render`, shared by overlay Play and the player; the worker only sends ordered commands. Decoded buffers are a guid-keyed, byte-accounted LRU separate from textures. A bounded pre-unlock queue starts after the first gesture. Decode or context failures report one diagnostic and the game continues.
- `AudioComponent` is optional; Play Sound needs none. The listener is the active game camera.
- Environmental reverb is a baked parametric bake (occupancy grid, sparse probes) feeding one shared bus, never runtime ray tracing or per-sound convolvers; a failed bake writes a marked dry fallback.
- Out of scope: streaming music, microphone capture, waveform editing, DSP plugin code.

### Particles

- Wrap Babylon particle systems as billboard quads only. No custom simulator, thin-instance particles, SPS, mesh particles, `ParticleHelper`, NPE UI, snippets or Babylon JSON payloads; own the schema and apply/lower in `render`.
- Basic Particle Emitter (module stack): `GPUParticleSystem` where supported, else CPU `ParticleSystem` capped at 512. Particle Graph: own IR, CPU-only in Babylon 9.29, Compiler Results warning above 512; documents never store a backend. Particle System: up to 8 slots of either kind.
- The look is a particle-domain Material; emitters have no Texture field. A missing Material skips the emitter with `particle.missing_material`; no default Material ships.
- Units are seconds (`updateSpeed = 1/60`). Blend and billboard modes map to Babylon constants by name.
- Unreleased engine: header versions stay 1 and normalizers fill new defaults (no migration).

## Asset system

### The .hasset container

- `magic "BABA" | version u32 | headerLen u32 | header JSON | chunk bytes`. The header holds guid, type, name, engine version, optional parent class, `dependencies`, `requiredDependencies`, `dependencyMetadataVersion`, a metadata `payload` and a chunk table (id, kind, mime, length, locator, sha256). Document bodies live in a `document` chunk.
- Header keys serialise sorted, so files are byte-stable (hashing, dedup, goldens).
- Header-only reads are a first-class codec operation; the registry indexes a whole project without touching payloads.
- **thin** (in-project, deps by guid) vs **bundled** (deps embedded as nested chunks, deduped by hash on import).
- Large chunks externalise into the content-addressed blob store `assets/.blobs/<sha256>` so saving a graph never rewrites textures; it is a locator variation, not a format change.

### The project folder

- `MyGame/` with `project.json` (startup scene guid, GameInstance class, registered editor objects, plugin/extension overrides by guid, export settings), `layout.json`, `assets/` (this tree *is* the Content Browser), `assets/.blobs/`, `plugins/`, `extensions/`.
- Two backends, one codec: directory (OPFS on web, Documents or an external folder natively, desktop) and zip (Export Project). No `.hproject` suffix.
- Derived data (compiled scripts, thumbnails, import cache, recovery journal, traces) lives in app-private storage keyed by project guid, never in the project folder.
- The codec is parameterised by manifest kind; `.hplugin` is the same container with a different manifest.

### Import pipeline

- Import uses `pickImportFiles` on every host. Importers are pure functions keyed by extension: images → Texture; glb/gltf → Model + Material + Texture + Animation; audio → Audio; woff2/woff/ttf/otf → Font (facetype JSON and MSDF pairs attach to an existing Font); `.hasset` → bundled unpack.
- Guids are unique within a project and its plugins, not globally. Templates keep their guids; importing from another project remaps colliding guids and rewrites references.

### Schema versioning

- Every header carries `version`; each type may own ordered N → N+1 migration steps applied on load.
- The engine is unreleased: no type registers a step and backward compatibility is not a goal. Older versions are refused as "unsupported old format"; newer versions are refused as "made with a newer engine version". Never silently accept, upgrade or drop fields.
- A step added later is tested with a committed golden of the released version it reads. Migration prompts once and never rewrites untouched files without saying so.

### Texture compression decision

- KTX2 with Basis Universal, transcoded at load (ASTC on Apple GPUs, BC7 on desktop, RGBA fallback), as an **import-pipeline** feature, not an export flag: the editor is the memory-constrained environment (2048² RGBA is 16 MB, ASTC 4×4 is 4 MB).
- UASTC + Zstd is the default (quality over download size; same VRAM as ETC1S). ETC1S is a per-texture option.
- Policy by usage: 3D material textures and normal maps → UASTC (normals never ETC1S); pixel-art sprites/tilesets, UI textures and fonts stay uncompressed. Compressed textures encode at a size rounded up to a multiple of 4 (WebGPU rejects unaligned blocks); atlases keep their size and decode to RGBA on WebGPU instead. Every default is a visible per-texture override.
- Encoding runs in one persistent dedicated import Worker (not a Service Worker or idle callbacks): one job at a time, transferable buffers, decode-then-clamp in the worker with a main-thread decode fallback, recycled after a few jobs (wasm heaps never shrink), paused during Preview and app background.
- The asset is usable from source bytes immediately. Compression states `pending` / `encoding` / `compressed` / `fallback_uncompressed` / `encode_failed` are badged in the Content Browser; Project Settings offers Retry Encoding; fallback assets re-queue once when the transcoder loads. Silent fallback is not allowed.
- Both source and KTX2 chunks are stored and committed (derived data does not travel through git); exports ship only the KTX2 variant when present.
- Project max import dimension (default 2048) and per-texture Downsample are authored; Engine Settings Editor Texture LOD affects only the editor and overlay Play, never packed games.

## Asset type catalog

Header types come from [document.ts](../../packages/core/src/document.ts); New Asset groups from `CREATABLE_ASSET_TYPE_GROUPS` in [content-browser-helpers.ts](../../apps/editor/src/lib/content-browser-helpers.ts).

| Group | Types |
| --- | --- |
| World | Scene (one Scene tab at a time), SceneLayer (2D overlay), Prefab (placeable components without logic) |
| Scripting | Class, Enum, Structure, ScriptInterface, SaveGame |
| Data and input | DataDefinition, DataTree, InputAction, InputAxis |
| 2D and animation | Sprite, SpriteAnimation, Tileset, Tilemap, AnimationGraph |
| Rendering | Material (the shader graph; there is no separate Shader type), MaterialFunction, MaterialInstance, RenderTarget, RenderTargetTexture, Water, ParticleEmitter, ParticleGraph, ParticleSystem, SkyboxCreator (editor-only helper) |
| Audio | AudioMixer, AudioChannel, SoundAttenuation |
| AI | BehaviourTree, Blackboard |
| Import-only | Texture, Model, Skeleton, Animation, Audio, Font |
| Not Content Browser assets | PluginSettings (one per plugin), Trace (`.htrace` in derived data) |

- **Class parents, not file types**: BObject, Actor, ActorComponent, GameInstance, GameSubsystem, SceneSubsystem (hidden abstract `Subsystem` is never offered), FunctionLibrary, EditorFunctionLibrary, EditorUtilityObject, BDebugCommand, BTTask, BTDecorator, BTService, BTComposite, plus scene/streaming/capture actor bases ([ids.ts](../../packages/object-model/src/ids.ts)).
- Every creatable class picks a parent at creation; re-parenting is supported with cycle detection and a diff of broken inherited members.
- EditorUtilityObject and EditorFunctionLibrary are editor-only and stripped from Play and export; leftover `EditorUtilityInterface` strings stay editor-only.
- **UserInterface / game HUD is removed and must not be re-added**: no UserInterface asset, no `@haptic/ui-runtime`, no WidgetComponent, no `ui.*` nodes, no Interface-domain materials, no Play/player Babylon GUI (`AdvancedDynamicTexture`), no `.ui.hasset` migration. `documentKindForAssetType("UserInterface")` is `null`.

## Object model

- `BObject` (guid, class, variables, `OnCreation` / `OnTick` / `OnDestroyed`); `Actor` adds transform, component tree, world membership, spawn/destroy; `ActorComponent` attaches to an Actor with its own tick and is the component scripting host (each attachment its own object).
- `GameInstance`: one per session from Project Settings; On Init / Tick / End (End only on application stop, never `changeScene`) plus scene loading events.
- Subsystems are engine-created singletons: every leaf GameSubsystem lives for the session and wraps the Game Instance lifecycle; every leaf SceneSubsystem lives with each main Scene (never streamed sub-scenes or SceneLayers). Created in class-id order with fixed guids, no registration list; graphs reach them with pure **Get `<ClassId>`** nodes.
- Engine components are listed in [engine-components.ts](../../packages/core/src/engine-components.ts) with their world/overlay placement. Colliders cover 3D and 2D shapes; the scene's physics world decides which apply.
- Interface calls on a target that does not implement the interface no-op and return pin defaults.
- Deterministic tick order: GameInstance → GameSubsystems → SceneSubsystems (gated by scene readiness) → Actors in spawn order → their components → physics step → post-physics boundary (deferred spawn/destroy flush). Never depend on Map iteration order across engines.

## Visual scripting

- **Pin types**: exec, bool, int, float, string, vec2/3/4, rotator, quat, transform, color, `objectRef(class)` (live instance), `actorRef(class)`, `classRef(class)` (class value, not an instance), `assetRef(type)`, struct and enum by guid (engine Hit Result, Collision Channel), array, map, delegate, wildcard, `tag`. Variables pick an inner type plus Container Single / Array / Map.
- **Assignability** lives only in [types.ts](../../packages/scripting/src/types.ts) with exhaustive tests: int → float widening; subclass → superclass of the same reference kind; any reference → `objectRef("BObject")`; `actorRef` → a wider `objectRef`; empty `assetRef` type matches any. Narrowing needs Cast. `classRef` never assigns to instance pins. Literal defaults are allowed on `classRef` but rejected on object/actor instance pins. Spawn Actor / Add Component `classId` pins are `classRef`, not strings.
- **Wildcards are two things**: a resolving wildcard is a compile-time generic shared by a resolution group (container nodes); a boxed wildcard is a runtime any (Print, user wildcard params). Anything boxes implicitly; unboxing is always explicit through the generated `WildcardTo*` family, which reports success plus fallback instead of throwing. `formatValue` in `core` backs Log, Print and `WildcardToString` and is golden-tested.
- Unconnected literal inputs edit inline on nodes; Engine Settings → Graph → Read-Only Pin Defaults locks them.
- **Compiler**: IR → deterministic plain JavaScript ES modules (no TypeScript, no transpiler in the browser). Exec flow becomes straight-line code with native `if`/`for`/`while`; pure nodes inline with CSE; latent nodes use async entry functions. Modules load by blob-URL dynamic import inside the worker. Each module gets `//# sourceURL=haptic:///<assetGuid>.js` and an anchor table (generated line/column → asset/graph/node); any pass that moves code rewrites anchors, and compiled game scripts are never minified.
- The node catalog in `scripting-nodes` is data-driven: id, title, category, pins, codegen; one test file per category.
- **Special compilation**:
  - ExecuteJavaScript: typed input/output pin lists (valid unique identifiers), body hoisted into a named module-scope function with pre-declared defaulted outputs, optional async (latent). Body parse errors report line/column in Compiler Results. It is unsandboxed by design; importing a foreign asset that contains bodies must disclose them.
  - Log: severity + category to the Output Log and a capped ring buffer that survives without the console UI.
  - Print: wildcard value through `formatValue`, keyed entries replace in place, newest first, clipped; HUD in Play and the player regardless of debugger bundling.
  - Draw Debug: world-space wireframes through commands; duration 0 lasts one simulation tick.
  - ExecuteConsoleCommand: works in every build; a stripped command returns failure with a message rather than throwing.
  - Print, Print String and Draw Debug default to **Development Only**: kept in editor Play and Preview Build, skipped by release export codegen (`stripDevelopmentOnly`). Any node can carry the flag.
- **Validation**: one pure validator in `scripting` (catalog packages register rules through a hook; BT structure uses `validateBehaviourTree` with the same diagnostic shape). Same code runs on edit (250 ms debounce), on save, before Preview (the scene being played, GameInstance, subsystems, the classes they reference, enabled plugin editor objects), on export and in CI.
- Diagnostic shape: severity, message, `assetGuid`, `graphId`, `nodeId`, optional `pinId` / `relatedNodeId`, stable `code` (`type.mismatch`, `exec.cycle`, …). Compiler Results, node badges, Content Browser overlays and the session report share it.
- Rule families: structural (unrooted nodes are omitted, not warned), pin typing (data inputs take one wire; exec inputs fan in; scripting exec outputs drive one wire), references, signatures, semantic, ExecuteJavaScript parse, behaviour tree. Export-preset rules (for example a debug-tier `ExecuteConsoleCommand`) run only at export.
- Warnings never block. Errors block Preview with a dialog that lists them with tap-to-navigate and **Play Anyway**; no persistent bypass. If the block is routinely bypassed, demote rules rather than harden the dialog.
- Data Definitions own typed fields and validation; Data Trees own hierarchical entries with stable ids; graphs read typed values from them.

## Editor windows, settings and undo

- Homepage owns create/open/close/recents; the editor shell runs only against an open project. Project tiers: app Documents (default on iPad, no picker), opt-in external folder (security-scoped, coordinated I/O, Reconnect flow), OPFS on web (Export Project to get a zip out).
- Every asset editor is a per-document DockView layout registered in [window-catalog.ts](../../apps/editor/src/shell/window-catalog.ts) so **Windows** can toggle panels and Focus can collapse to a keep-list ([dockview-editor-tabs.md](../rules/dockview-editor-tabs.md)). The pinned Content Browser is not a DockView document.
- Phone-sized windows show one dock window at a time without overwriting the saved tablet layout.
- **Engine Settings** are global to the install, stored outside projects through the `vfs` app-settings port (undo limits, viewport frame cap, budgets, debugger defaults, Focus keep-lists, graph defaults); they persist immediately.
- **Project Settings** live in `project.json` and save with Save All (startup scene, GameInstance, rendering incl. frame cap and game render size, texture policy, physics, plugins, extensions, source control repo/branch, export presets, compile-on-save, autosave interval). The source-control token lives in the platform secret store, never in the file.
- Rule: if a setting should change the exported game, it belongs in Project Settings; if it only changes how the editor feels on this machine, it belongs in Engine Settings. The two are separate modals, never nested.
- Undo is **per document**, never global. `edit` command objects have `apply`, `invert` and a merge key; no surface mutates a document model directly. Continuous gestures coalesce into one entry; completed edits stay separate. Entry limit (default 50) and byte budget (default 16 MB) both apply.
- Undo boundary = asset-file boundary: everything inside a document (including adding/removing actors, nodes, components) is undoable; asset/folder/plugin/project create and delete are not, and deletion uses a destructive dialog that names the selection and lists inbound references.
- Autosave (default 120 s) and crash recovery: the command stream journals in batches to derived data; reopening seals the earlier session's records and offers recovery, which only Recover or Discard ends (saves, autosave and Close truncate only edits made since the reopen). Recovery reuses the command layer, never a second serialisation path.
- Preview Build is a Debug-menu **Play Mode** beside Play and Simulate (Play by default; the choice is remembered); overlay Play remains the default and is never replaced. **Start In Open Scene** (default on) seeds the open scene tab, else the project startup scene; Simulate always uses the open scene.

## Touch-first design system

- Canonical shadcn theme tokens live only in [tokens.css](../../packages/ui/src/styles/tokens.css), which [globals.css](../../packages/ui/src/styles/globals.css) imports; Scene, Prefab and graph canvases stay dark regardless of theme. Rules: [gesture rules](architecture.md#gesture-rules).
- Compose chrome from `@haptic/ui` and `@haptic/editor-kit`; no raw styled `<input>`, `<select>` or `<button>` in `apps/editor/src`. Pick lists use `SearchDialog` / `SearchDropdown`; no full-width bottom Sheets.
- Density: `--chrome-row` 28px for chrome, rows and tree items; `--touch-target` 44px for graph pin rows and grips. Dock tab strips 26px compact / 30px touch. Compact desktop controls stay compact.
- Compact Mode is an application setting, on by default except on iOS and Android; touch-sized controls and rows appear only while it is off, so a touchscreen laptop stays compact and an iPad with a trackpad can opt in. Gestures always follow the real pointer.
- Rounded radius token scale; no square corners and no hardcoded radii.
- Text is not selectable by default (`user-select: none`, `-webkit-touch-callout: none`); inputs, `contenteditable` and `SelectableText` opt back in.
- Long-press (500 ms, 8px tolerance, matching Dockview) is the primary context-menu gesture; right-click is the secondary path; the native menu is suppressed app-wide.
- No hover-only affordances; catalog dialogs do not autofocus search (the iPad keyboard would cover them); Global Search may.
- Dockview `dndStrategy` is `'auto'` (pointer events for touch inside WKWebView).

## Debugging tiers

- The command system is always present; only the debugger UI and debug-tier commands are optional and tree-shaken out of non-debug exports.
- Core commands ship in every build: `changescene`, `quality` (and its groups), `renderpath`, `fixedlights`, `framecap`, `volume`, `quit`, `help`, and every user `BDebugCommand`. Debug-tier commands (`stat *`, `showcollision`, `wireframe`, `pause`, `step`, `slomo`, `freecam`, `possess`, `destroyactor`, `dumplog`, …) ship only with the bundled debugger ([packages/debugger/src](../../packages/debugger/src/)).
- Engine command names are reserved; a colliding user command fails at edit time.
- Stats HUD on the main thread at about 5 Hz, splitting render, script and physics time; memory shown as accounted bytes; per-channel bridge traffic. HUDs never `setState` at 60 Hz.
- The trace recorder spills `.htrace` (same container format) to derived data; with input stream and RNG seed it replays through the headless harness.
- Release exports honour bundle-debugger and `stripDevelopmentOnly`; Preview Build always bundles the debugger and keeps Development Only nodes.
- Preview session report: uncaught worker errors, Error logs, engine assertions and BT node throws (a BT Failure is control flow, never an error), deduplicated by `(code, assetGuid, nodeId)` with counts and a per-session cap; stack frames map to nodes through anchor tables; WebKit and V8 stack formats both parse. The report is nonmodal and only its own Close, title-bar close or Escape pressed while focus is inside it dismiss it; Escape elsewhere reaches the editor. A row opens the asset that owns the entry (Class scripts report their asset path; trees, Scenes, Scene Layers and Models their guid), focuses the node (a function graph's tab comes forward) and moves the keyboard into that document; an entry with no openable asset reads **No Source**, and a refused open is explained in the report.
- **Simulate** is a Debug-menu **Play Mode** that runs the open world Scene in its Scene Viewport with live runtime edits. **Keep Simulation Changes** (Engine Settings > Debugger, off by default) applies the complete final persistable scene as one **Apply Simulation Changes** undo step when it stops; a session holding unsupported scene instances, scene transitions or resources can only be discarded, never partially applied.
- Simulation graph debugging: with a Class, Behaviour Tree or Animation Graph open, a toolbar **Debug Instance** select follows one live object that runs it (a Class's exact instances, or the components that run the tree or graph); its nodes, wires and pins flash for a quarter second when they run. Class pins show their last value on hover or label tap; Behaviour Tree nodes show **Running**, **Success** or **Failure**; an Animation Graph flashes the states it samples and the transitions it takes. Editor-only, read-only, Simulation-only and free when unobserved.

## Plugins and extensions

- A plugin is a folder with one `PluginSettings` asset and its own `assets/`; it extends the engine only through things a project can already author (classes, graphs, editor utilities, interfaces, content). No dynamic code loading beyond compiled scripts.
- The registry is multi-root: the project plus one root per enabled plugin; references across roots are ordinary guid references.
- The plugin guid, not the folder name, is identity. Disabling a plugin that content depends on warns first; a missing plugin resolves to guid-keeping placeholders, never data loss.
- Enable precedence: plugin default < project override (by guid in `project.json`) < export-preset override.
- Version differences are nonblocking warnings; missing dependencies and cycles block.
- `.hplugin` reuses the project codec; archives never appear as assets. Show Plugin Content is off by default. Engine plugin content is read-only; new projects copy bundled plugins into `plugins/` with the same guids.
- Disabled plugins contribute nothing to an exported game; Export Project is a full backup.
- Editor Extensions are editor-only TS/JS modules (`extension.json` + `activate(api)`, `.hextension` archives) managed per project; they never become runtime asset roots or game modules, and imports stay disabled until enabled.

## Input

- One normalised stream from touch/pointer, gamepad, keyboard and mouse. Gamepads are polled once per frame on the main thread into the same tick-stamped ring buffer; the worker sees only actions and axes.
- Mappings live in InputAction / InputAxis assets with stable binding ids so player overrides survive renames. Only the Basic 3D template ships starter Input assets.
- Touch axes come from SceneLayer `2DJoystickComponent` controls (test hook: `injectTestTouchAxis`). There is no Set Input Mode.
- Every finger, pen tip and left mouse button is a touch with a stable finger slot, read by the touch nodes; the first one is still Mouse Left and the cursor. Pointers that SceneLayer joysticks, 2D controls or scroll drags own never reach game input.
- Every event is stamped with the tick it applies to; input is tested by feeding synthetic streams to the deterministic harness.
- The game canvas uses pointer capture and `touch-action: none`. Focused UI (text fields, buttons, modals) owns keys before gameplay.
- Text: 3D Text is a flat TypeFace mesh (`CreateTextShapePaths` + `CreatePolygon` + `earcut`); 2D text uses Bitmap FontFace quads with optional MSDF; CSS FontFace registration from bytes is the only way custom fonts reach rendering. Fonts load before first paint and fail loudly. Font metrics are main-thread only.

## Source control

- Optional, per project, off by default; when off there is no polling, token, network or UI difference. Hidden on production web.
- Implements only the Git LFS locking REST API (`POST /locks`, `/locks/verify`, `/locks/:id/unlock`) behind a `LockProvider` port with a fake. Repo URL and branch are explicit settings, never parsed from `.git`.
- Auto-lock on first edit (the create call is the atomic check). Failure never blocks work; locks are advisory (read-only by default with Edit Anyway). `lockable` is never added to `.gitattributes`.
- Release is explicit only (Release All My Locks with a warning, or per asset); never on a timer, close or heuristic, because the engine cannot observe a push.
- External change is normal: on foreground the registry rescans and offers reloads, warning loudly when a dirty document's file changed.
- Git status is never shown (the engine never reads git state).

## 2D

- Same scene graph, actors, scripting and physics slot as 3D, viewed through an orthographic camera.
- Convention: XY plane, +Y up, +X right, camera at negative Z looking +Z (forced by Babylon's left-handedness). Depth ordering is a sorting concern.
- The viewport 2D/3D toggle switches camera, navigation (pan/zoom only), gizmos (XY translate, Z rotate, XY scale), grid and camera-bounds overlay. `viewportMode` is an authored, saved and undoable scene setting.
- **Sprites are quad meshes, not Babylon Sprites**: a Babylon `Sprite` cannot parent, take custom materials, carry physics shapes or join normal picking. One quad per sprite with the frame baked into UVs; batching and thin instances are measured escape hatches only.
- Sprites alpha-test by default (opaque pass, no sort); blending is opt-in. Pixel art uses nearest sampling, no mips, anisotropy 1, set at creation.
- Sprite holds atlas frames, look, pivot and collision AABB; SpriteAnimation is the separate pickable clip for Animation Graph.
- Tilemaps render as chunked `VertexData` from a pure golden-tested function (one draw per chunk per atlas, only affected chunks rebuilt), not `SpriteMap`. Painting is one undo entry per stroke. Autotile is deferred.
- 2D physics is a dedicated Rapier backend (`@dimforge/rapier2d-deterministic-compat`), loaded only for 2D worlds, because constraining Havok to a plane needs an anchor body and 6DOF constraint per body and distorts impulses. A scene never mixes worlds; each physics-enabled SceneLayer gets its own 2D world. Tilemap collision uses merged chain colliders per chunk. Never substitute the software backend for a failed wasm load; never add `planck.js`.
- `pixelsPerUnit` (default 100) is the single pixel ↔ world conversion. Sorting is an explicit named layer list plus order, compiled to one key on `alphaIndex`; rendering groups are reserved for coarse separation.

## AI

- **Behaviour trees** are React Flow graphs in `graph-ui` with parent-child edges; sibling order is `children[]`, never wire topology. Decorators and services render as attached rows, not nodes. Positions (`editorPositions`) are optional; Auto Arrange never changes `children[]`; the runtime ignores positions.
- Composites (Selector, Sequence, Parallel), tasks, decorators (gate entry, can abort Self / Lower Priority / Both) and services (interval tick). Every kind is a `BObject` subclass implemented with visual scripting.
- Tree structure is data interpreted by a deterministic explicit-stack evaluator in the worker; node logic is compiled JS. Abort semantics get a table-driven test matrix.
- Blackboard keys use the pin type system; trees and blackboards are separate assets. `BehaviourTreeComponent` attaches to any Actor (no AI controller concept).
- **Navigation** uses `recast-navigation-js` for both bake (`@recast-navigation/generators`) and query (`@recast-navigation/core`) so the serialised navmesh is one library's own round trip. Babylon's `RecastJSPlugin` (Scene-coupled, main-thread-only) and `@recast-navigation/babylon` are not used.
- The editor bakes in a worker and stores bytes as a Scene chunk; the game worker imports and queries with no Babylon. Never generate a navmesh at game start.
- Geometry collection is main-thread work, so Bake opens a blocking modal before collecting (painted first, input captured, cancellable only while the worker generates). Auto-bake on save is opt-in and off by default.
- Crowd facing derives from velocity with a minimum-length guard. Dynamic rigid bodies keep physics and gravity while NavAgent steers.
- One navmesh system for 2D and 3D through a single pure XY ↔ Recast XZ conversion pair with round-trip property tests; nothing else touches Recast coordinates.

## Export and distribution

- `packages/exporter` builds a web/itch.io zip: `index.html` at the root, one player bundle (code splitting off; workers separate), `game.json` catalog, one `assets/data-<n>.bin` per reached asset with length and SHA-256 revision, compiled-script sidecars, separate wasm (physics, KTX2 transcoder) and `coi-serviceworker.js`.
- Tree-shake from `project.json` `startupSceneGuid` plus GameInstance references and every subsystem Class; strip editor-only types and disabled plugins. Never boot from a manifest path or guess `main.scene.hasset`.
- Third-party notices are generated by `scripts/third-party-notices.mjs` from the installed production dependency tree plus `scripts/third-party-notices/vendored.json` (vendored runtime files). It writes `apps/editor/public/legal/THIRD-PARTY-NOTICES.txt` (player scope; `legal/` ships in every export and Preview Build) and `apps/editor/src/lib/third-party-notices.json` (editor scope, lazily loaded by Manage Account > Application > Third-Party Notices). A tooling test fails when either is stale; regenerate after a dependency or vendored-file change. Havok (`@babylonjs/havok`) is MIT.
- itch.io caps uploads at 1000 files: the exporter reports the count, warns at 800 and fails at 1000 by default; the export smoke test asserts boot, ticks and file count on range-capable and range-blind servers.
- Preview Build packs the same way into memory and runs `apps/player` in a same-origin iframe (never `window.open`); the pack is never written to the project and is rebuilt every time; messages check exact origin and window.
- Editor hosts: Capacitor 8 iPad/Android with first-party native plugins (secrets, scoped storage, audio lifecycle, memory stats) and Electron desktop with a Node VFS adapter.
- Packaging, signing, store upload and release publication follow [distribution.md](../rules/distribution.md) and require explicit authorisation.

## Dependency upgrade policy

- Babylon packages are pinned to one exact version across editor, player, render and physics, with a repository patch; an upgrade is its own change that re-applies the patch and re-checks particle, material and WebGPU behaviour.
- Add a dependency only when it removes real risk; record the rejected alternative. Settled choices: `dockview-react` 8 (touch docking), `@xyflow/react` 12, Vitest 4, Playwright, `zod` 4, `fflate`, `fast-check`, Rapier deterministic 2D, recast-navigation core/generators, `d3-hierarchy` (not `elkjs`), CodeMirror 6 loaded lazily (not Monaco), `meshoptimizer`, `earcut` injected.
- Deliberately absent: Comlink on the hot path, `planck.js`, `@recast-navigation/babylon`, `@babylonjs/addons` / `@babylonjs/materials`, a list virtualizer library.
- Vendored, never fetched from a CDN: `coi-serviceworker.js` (locally modified), the Basis encoder and KTX2 transcoder set, Havok wasm.
- Heavy optional runtimes (Rapier, Recast, CodeMirror) load only when a scene or editor surface needs them.

## Open work

- Hardware-only device checks: the Working Copy / `NSFileCoordinator` Swift plugin, cold-launch reopen on iPad for both storage tiers, Capacitor write timings, WKWebView `Error.stack` parsing, and Play holding 60 fps on the A16.
- Water performance qualification: confirm the many-body CPU savings on the A16 iPad (Medium) and a budget Android phone (Low).
- Mid-game compiles still holding the picture: a new shadow map (its casters' depth variants and the frame-setup rebuild), spawned Materials no load warmed (to be warmed at load and hidden per mesh until ready), and WebGPU pipelines (to draw the previous pipeline while the new one compiles). The first draw of each new program on iPad WebKit WebGL2 still blocks its thread (about 100 ms each); loading warm-up and spreading first draws across frames reduce it, nothing removes it. Predicting and compiling ahead (lights coming into range, shadows about to start) is planned.

## Key risks

- iPad memory and thermals; our accounting is the only memory signal, so a wrong bytes-per-texel constant silently breaks every budget.
- A visible editor viewport never freezes by itself; occlusion and modal detection must keep working.
- Physics and scripts share one tick budget; watch for scenes where physics alone exceeds its share.
- SAB unavailable on the primary host; transferable fallback must stay exercised.
- Blob-URL module import and `Error.stack` parsing inside WKWebView underpin scripting and the session report.
- Scoped storage through external file providers (stale bookmarks, coordination) and many small writes across the Capacitor bridge; mitigated by dirty-only saves, the blob store and debounced writes (one file per asset, no pack format).
- Fonts fail silently (unloaded faces render as a fallback); assert real rendering on cold load.
- Two physics backends can drift; run shared scenario shapes against both.
- Tilemap chunk rebuild cost per stroke; Recast crowd determinism across builds; the 2D axis remap sign.
- ExecuteJavaScript runs with full worker privileges; disclosure on import is the mitigation.
- CPU-only Particle Graphs on A16; untested device cost.
- Cross-root asset moves need an explicit fix-up pass; class re-parenting invalidates inherited members.

## Intended behaviour

Deliberate product decisions that can look like bugs. Do not "fix" them without a product decision.

- Gameplay logic lives in Class event graphs; the scene's Game Instance row only displays the project setting; Material is the shader graph editor.
- Animation Graph variables are restricted to Bool, Int, Float, String, Tag and Tag Container.
- Windows and Focus are disabled on the pinned Content Browser; the last remaining dock panel cannot be closed.
- Toggling 2D/3D dirties the scene: it is an authored, undoable setting.
- Engine Settings save immediately; Project Settings save with Save All.
- Undoing back to the saved content makes a document clean again; Redo makes it dirty.
- Duplicate actor display names are allowed (ids are identity; Outliner and pickers disambiguate). Asset names, folder names and Class ids must be unique; Duplicate keeps the source transform (no automatic offset).
- Right-click or long-press on an unselected item replaces the selection; on a selected item it keeps the group.
- Multi-actor Inspector edits shared transform and visibility; components belong to the primary actor only.
- Escape in an Inspector field or colour picker cancels the uncommitted draft; Done/commit applies it.
- The Play Debug menu controls which overlay buttons exist; the Stats HUD starts collapsed until tapped.
- Print is HUD output; the console and log history are a separate sink. Development Only nodes run in editor Play and Preview Build and are stripped from release export.
- The Play Inspector is a read-only snapshot (plus Use Camera and Destroy Actor); runtime changes never write back to authored content.
- Play and Preview launch the open Scene tab (Start In Open Scene) or the startup scene, not the active asset tab.
- Spawning every Tick is allowed: there is no actor cap, throttle or kill-Z. An empty class reference spawns nothing (safe null); Destroy Actor on null no-ops. An Actor or Target pin left unwired means Self only where the node says so (a pin labelled `(Self)`: Destroy Actor, Get/Has/Add Component, Play/Stop Particles, Attach To Bone, and the Target of Call Function, Call Custom Event, Call Interface Function and Get Component Ref on the graph's own class); a wired reference that is null never falls back to Self: the node does nothing and the runtime logs "<Class>: <Node> (<Pin>) tried to access null." on every occurrence.
- Class references and actor references are distinct pin kinds; a wrong-type wire is rejected.
- Map and Array nodes are immutable values: Set/Append return new containers and need a write-back to the variable; value-type keys compare by value. Unwired impure nodes do not execute.
- Releasing a dragged pin in the empty-canvas safe zone breaks its wires; a data input takes one wire (a new wire replaces it).
- Trigger pairs raise Overlap and solid pairs raise Hit; a missing Collider is never auto-added. ColliderComponent editor outlines always draw; Show Collisions controls only Mesh outlines.
- Is Path Valid and Find Look At take From/To vectors; there is no path or actor overload.
- Get Axis returns a scalar magnitude; use Get Axis 2D for vectors.
- Infinite synchronous loops are guarded at runtime and warned at compile time where provable; termination of data-dependent loops is not decided at compile time.
- Particle capacity has a minimum of 16 and Pre Warm caps at 10 s.
- Basic 3D has no ambient fill light and the skybox supplies no IBL; unlit faces away from the sun are dark.
- Editor camera joystick defaults on.
- Console arguments containing spaces need quotes; `actorboundingbox` takes a Boolean.
- Space activates a focused toolbar button (native button semantics) until focus returns to the canvas.
- No networking, replication, game HUD, Timeline/Sequencer or AI controller exists; their absence is scope, not a defect.
