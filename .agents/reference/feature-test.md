# Feature Test project

Inventory and rules for the built-in **Feature Test** starter (`apps/editor/src/lib/feature-test/`): what each scene and zone authors, the workload knobs, media slots, on-device check, perf route and known gaps. It showcases every engine feature in one project and is the agents' default deterministic performance workload. The [FeatureTest rule](../rules/feature-test.md) requires any feature change to update the scaffold, this file and the scaffold test in the same PR.

## How it is built

- Create Project → Feature Test (listed only in Debug Mode). `ProjectService.createEmptyProject(name, { kind: "feature-test" })` runs the Basic 3D scaffold (Input assets, Kenney Mannequin) and then lazily loads [`apps/editor/src/lib/feature-test/`](../../apps/editor/src/lib/feature-test/).
- `index.ts` runs areas in a fixed order so every referenced asset exists before its referrer: imports, audio, materials, scripting types, scripting, rendering, physics, world, animation, particles, AI, 2D, Scene Layers. Area modules then place actors in their zones. Scene documents save last (Scene Layers, sub-scenes, scenes, then the main scene), then the navmesh bake and project settings.
- Content is deterministic: fixed ids, positions and counts. Only asset guids differ between projects, so tooling finds assets by path or name.
- Feature Test's own assets live under `assets/FeatureTest/<Area>/`, an Always Package Folder, so Preview Build and export ship the whole showcase. The Basic 3D scaffold keeps its files where it writes them: the startup scene `assets/main.scene.hasset`, Input assets under `assets/Input/`, and the Mannequin (`assets/Mannequin/` plus `assets/Mannequin.class.hasset`), which the areas reuse.
- Zones sit on a 32 m grid in [`layout.ts`](../../apps/editor/src/lib/feature-test/layout.ts) (`FEATURE_TEST_ZONES`); each has an Outliner folder and a 3D Text label. The main camera `ft-camera-main` (`FT_RenderCameraTour`) starts at the head of the closed `FEATURE_TEST_CAMERA_TOUR` Spline (`Camera Tour Path`, `FT_RenderCameraPath`) and, in Play, Preview and export, rides it at 6 m/s (about 2.5 min a lap) on a lagging Spring Arm: in front of the first row, low through both gaps between rows, high behind the back row and down the left side. Play-frame measurements of the main scene therefore see a moving view. Landscape and water live in the separate `FT_World` scene.

## Source content

Only existing repository files and runtime primitives are used (no generated artwork; [no-ai-artwork](../rules/no-ai-artwork.md)). The required file list is [`engine-content-files.ts`](../../apps/editor/src/lib/feature-test/engine-content-files.ts), shared by the Vite copy plugin and the browser scaffold.

| Content | Source | Use |
| --- | --- | --- |
| Kenney Mannequin | `engine-content/kenney-assets/Mannequin` (Basic 3D) | Hierarchy Skeleton, 27 clips, animation, ragdoll, crowds |
| Holiday Pack subset | `engine-content/kenney-assets/Holiday Pack` (CC0, `License.txt`, `Source.txt`) | Models, foliage, buoyancy, Automatic LOD (menorah), rigid node animation (door) |
| Holiday colormap | `Holiday Pack/Textures/colormap.png` | Albedo Texture (KTX2 encode path), Pixel Art copy for HUD panels and an authored multi-frame Sprite |
| Kenney platformer art | `engine-content/kenney-assets/Platformer` (CC0, Platformer Pack Redux tilesheet and toon robot frames; `License.txt`, `Source.txt`) | `FT_2D` Tilesets, robot Sprites and Sprite Animations |
| Skybox faces and net | `engine-content/skybox` | Skybox Texture faces, Skybox Creator source |
| Billboards | `engine-content/billboards` | UI Textures |
| Onest | `engine-content/fonts/Onest` (SIL OFL 1.1, `OFL.txt` + `Source.txt` alongside; keep `OFL.txt` with any export that ships the font) | Source Font for overlay text |
| Bundled ASCII glyphs | `@haptic/render/default-typeface` | Facetype Font for 3D Text |

A new third-party pack must be human-made and CC0 (fonts: OFL), ship its `License.txt` (or `OFL.txt`) and `Source.txt` beside it, and be listed in this table.

### Media slots

Audio and the color grading LUT come from human-made CC0 files in fixed slots. New projects pick up whatever is present at build time (`vite-engine-content.ts` publishes a `slots.json` manifest so the browser never probes missing URLs):

| Slot | Path | Shipped | Effect when present |
| --- | --- | --- | --- |
| Loop audio | `engine-content/feature-test/audio/FT_Loop.ogg` (or `.wav`, `.mp3`) | Kenney `upgrade1.wav` | Spatial Audio Components play it |
| One-shot audio | `engine-content/feature-test/audio/FT_OneShot.ogg` (or `.wav`, `.mp3`) | Kenney `coin1.wav` | UI and gameplay cues |
| Color grading LUT | `engine-content/feature-test/lut/FT_Grade_lut.png` (strip: width = size², height = size) | none | Project color grading is enabled |

The Kenney sounds are CC0; `License.txt` and `Source.txt` beside them record license and origin. Replace a slot file to change the sound; an empty slot leaves the feature authored but silent or ungraded.

## Scenes

| Scene | Path | Purpose |
| --- | --- | --- |
| Main | `assets/main.scene.hasset` | Every 3D feature except the open world, in fixed zones at moderate cost; startup scene and default perf workload |
| FT_Stress | `assets/FeatureTest/Scenes/FT_Stress.scene.hasset` | Heavy, scalable load: physics pile, particle stress, animated crowd, dense foliage |
| FT_World | `assets/FeatureTest/Scenes/FT_World.scene.hasset` | Landscape, Foliage, every water body kind, buoyancy, Cables and Splines |
| FT_Clustered | `assets/FeatureTest/Scenes/FT_Clustered.scene.hasset` | Many unshadowed point lights for Clustered Forward comparisons |
| FT_2D | `assets/FeatureTest/Scenes/FT_2D.scene.hasset` | Sprites, Sprite Animation, Tilemaps, 2D physics |
| FT_StreamedRoom | `assets/FeatureTest/Scenes/FT_StreamedRoom.scene.hasset` | Sub-scene streamed into the main scene |

Open a scene from the Content Browser, or use the console `changescene` command in Play.

## Main scene zones

The scene spawns the `FT_HUD` and `FT_OverlayPhysics` Scene Layers in Play.

| Zone (center x, z) | Module | Contents |
| --- | --- | --- |
| Feature Test hub (0, 0) | `index.ts` | Basic 3D Mannequin (idle Animation Graph, kinematic capsule) and floor. Scene-wide: texture-face skybox, shadowed sun, post-process entry `FT_MatPostGrade`, exponential fog, and the camera tour (`rendering.ts`): `FT_RenderCameraTour` Tick wraps Distance with Get Spline Length and follows Get Location At Distance Along Spline on the `FT_RenderCameraPath` Spline. |
| Meshes And Materials (-32, 0) | `materials.ts` | Every primitive kind; `FT_MatSurface` (colormap, Material Function tint, pulse), `FT_MatSurfaceInstance` and a chained metal instance, scene-owned instance overrides, `FT_MatEmissive` (scrolling bands), `FT_MatGlass` (translucent, WPO ripple, Fresnel rim glow), `FT_MatNoiseMasked` (alpha clip). Holiday models keep their slot Materials; one uses a `materialGuid` override. |
| Lights And Shadows (32, 0) | `rendering.ts` | Shadowed spot, shadowed point (cube shadows from a pillar ring), three unshadowed color point lights, unshadowed spot, Area Rect Light, Hemispheric Fill Light. |
| Effects (-64, 0) | `rendering.ts` | Fog Volume around a glowing sphere; x-ray Outline through an occluder wall; lattice Deformer; 3D Text with the facetype Font and the bundled face; Dynamic Runtime Mesh pyramid (`FT_RenderDynamicMesh`, Play only); Spring Arm rig with lag (`FT_RenderSpringArmRig`); orthographic `Effects Ortho Camera`. |
| Render Targets (64, 0) | `rendering.ts` | Scene Color (512, every frame, Quality Fast: the Fast side of the comparison with `FT_World`'s Full Quality lake capture), Depth Pass (256, every frame) and World Normal (256, one manual capture by `FT_RenderCaptureManual`) captures of a four-actor subject group (Capture Only Actors), each on a monitor Material sampling its Render Target Texture. |
| Audio (-64, 32) | `audio.ts` | Spatial loop, one-shot cue and looping cue emitters, a muffle wall and a reverb back wall. Channels `FT_AudioMaster` → `FT_AudioWorld` → `FT_AudioCues`; attenuations `FT_AudioNear`, `FT_AudioWide`; `FT_AudioMixer` is the project mixer. `possess "Audio Listener Camera"` to hear them. |
| Physics (-32, 32) | `physics.ts` | Box, capsule, convex, cylinder and bouncy sphere bodies; friction ramp; triangle-mesh trough; 15-box stack; rising balloon and damped sphere; `Ghost` collision layer wall (the ball on the Dynamic preset lands on it; the Ghost Pass ball overlaps it and falls through); trigger launch pad (`FT_PhysLaunchPad`); kinematic sweeper (`FT_PhysSweeper`). |
| Constraints And Movement (0, 32) | `physics.ts` | Ball-socket pendulum, distance rod, limited hinge, 8-link chain, fixed weld, Mannequin ragdoll, Blocking Volume shelf, three Movement walkers on circular loops (`FT_PhysWalker`: two character-controller walkers, one hopping; `FT_PhysBodyWalker`: a dynamic Rigid Body that Movement steers) and two `FT_PhysLaunchPad` instances that throw a controller walker and the body walker. |
| Animation (32, 32) | `animation.ts` | Six Mannequins on `FT_AnimLocomotion` (Idle, Walk, Run, Cheer) driven by `FT_AnimLocomotor` variables; the Holiday door swinging on `FT_AnimDoorSwing` (rigid node animation). |
| Particles (64, 32) | `particles.ts` | `FT_FxShowcase` (Basic emitter + Particle Graph `FT_FxGlowGraph`), `FT_FxSparks` (additive bursts), `FT_FxSmoke` (local space, Material Instance). Sorting demo: the fountain is on the project's custom `Characters` sorting layer (order 0), an `FT_FxSmoke` mist around it on Default (order 5); the layer outranks the order, so water draws over the mist. |
| Scene Streaming (-64, 64) | `scripting.ts` | `FT_StreamLoader` (SceneStreamingActor + Scene Streaming Component) streams in `FT_StreamedRoom` 1.5 s after Begin Play. |
| Scripting (-32, 64) | `scripting.ts` | 4x4 `FT_ScriptSpinner` grid (enum, structure and tag variables, custom event, interface, subsystem call, static Function Library, input) plus `FT_ScriptSpinnerFast` (inheritance and override); interface, data and save probes; `FT_ScriptTouchProbe` (every touch node: touch events, Get Touch Count, Get Touch, Find Touch, Project Touch To Scene); three logic-free `FT_ScriptMarker` Prefab instances. |
| AI And Navigation (0, 64) | `ai.ts` | Baked tile-cache navmesh (bounds inside the zone), static, cost and dynamic blockers, four guards on `FT_AIPatrolTree` (every built-in composite, decorator and service, every built-in task except Play Animation and Play Sound, and the custom BT Task, Decorator, Service and Composite classes), and a Mannequin sentry on `FT_AISentryTree` (Play Animation and Play Sound, when a Mannequin clip and the one-shot audio slot exist). |
| Model LOD (64, 64) | `rendering.ts` | Five menorah instances (1150 triangles) at 4 to 48 m from `LOD Lane Camera` for Automatic Model LOD. |

## Other scenes and layers

| Document | Contents |
| --- | --- |
| `FT_Stress` | 320 dynamic bodies over a scaled sweeper, 6 ragdolls, a 32-link chain; 4 stress particle actors (about 16 000 GPU particles); an 8x8 animated Mannequin crowd; a 5184-instance foliage carpet. |
| `FT_World` (`world.ts`) | 80 m island Landscape (grass, snow, sand, rock layers, collision), 226 foliage instances, Global Sea at -6 m (object reflections off), Ocean (Ocean Spectrum waves, object reflections), Lake, River and Puddle bodies, Dry Dock removal volume, buoyant presents, seven Cables, two editor Splines; shadowed sun and light fog. A Full Quality Render Target Capture of the Lake from the south shore (256², every frame) on a captioned monitor facing the world camera, refracting the lake bed and drawing its own sun shadow cascades as the world camera does. Separate from the main scene because an Ocean over every main-scene zone made the main scene miss its loading deadline on software GL. |
| `FT_Clustered` | 48 unshadowed point lights over a plain floor with the engine default sky, so Auto can select Clustered Forward. |
| `FT_2D` | Orthographic camera over a 16x9 Tilemap of 128 px Kenney platformer tiles: parallax backdrop, collision ground (grass on dirt, crates, chain ramp, top-edge ledges, animated switch blocks), decor layer from a second Tileset (animated water and torches, signs, plants). `FT_2DTiles` defines two autotile terrains: Grass (8-neighbour blob on the sheet's grass and dirt cells, incomplete, so it relies on closest-match) and Ledge (4-side, the thin ledge pieces). `two-d.ts` paints the floating ledge with a Ledge brush stroke and a stepped backdrop island (grass top, inner corner, fill) with Grass rect and brush strokes through `applyTilemapPaint`; the scaffold test checks a Tilemap holds terrain tiles of every style. `FT_2DRobotGraph` cycles robot Idle, Walk, Jump, Fall Sprite Animations on a mascot and a dynamic walking robot; 32 falling robot bodies use every 2D collider shape; chain funnel; hinge pendulum; custom `Characters` sorting layer. |
| `FT_StreamedRoom` | Platform, pillars, sign and a streamed spinner; no camera or lights. |
| `FT_HUD` (Scene Layer) | Every overlay widget: text with the Text-domain Material, rich text, panels, safe area, form controls, scroll box, virtualized list (10 000 rows) and grid (400 cells), mask and mask panel, texture, material swatch, click button (`FT_UIClickButton`), focus target, card switcher (`FT_UICardSwitcher`), joystick bound to Move, persistent painter. Focus navigation uses Confirm. |
| `FT_OverlayPhysics` (Scene Layer) | Eight 2D bodies falling into a pit in the overlay's own physics world. `FT_UIPitCounter` counts them each tick with Sphere Overlap Actors (Dynamic) from a layer actor's script, which reads the layer's world rather than main-Scene bodies at the same coordinates; its label updates only on change. `showcollision` draws the pit and boxes in the layer. `FT_UICameraRig` runs every Scene Layer camera node on Begin Play: Get Owning Scene Layer, then tweens the layer camera's location, zoom and rotation from their Get values and sets them back to the default, so the pit ends where it was authored. |

## Scripting, data and settings

- **Game Instance** `FT_GameInstance` (Project Settings): logs on init; on the first scene prints the scene name, spawns `FT_ScriptSpawned` when the Scripting zone exists, and runs `ft_stats`. **Subsystems**: `FT_GameScoreSubsystem` (GameSubsystem), `FT_GameSceneWatcher` (SceneSubsystem).
- **Editor**: `FT_EditorProbe` (EditorUtilityObject, registered) logs editor events; `FT_EditorMath` (EditorFunctionLibrary) is authored only.
- **Types and data**: `FT_ScriptSpeedMode` (Enum), `FT_ScriptSpinConfig` (Structure), `FT_ScriptDescribable` (ScriptInterface), `FT_DataItemStats` / `FT_DataItems` (Data Definition and Data Tree), `FT_DataProgress` (SaveGame, `wipeOnPlay` on).
- **Input**: Basic 3D actions plus `FT_ScriptPulse` (P or pad button 3; every press also rumbles pad 0 through Set Gamepad Rumble) and `FT_ScriptNudge` (arrow keys); the HUD joystick adds touch bindings to Move.
- **Project settings**: Feature Test tags, collision layers Default, Dynamic, Trigger, Water, Ghost, with Collision Presets Default, Dynamic, Trigger, Ghost and Ghost Pass (Dynamic layer; Overlap on Ghost, Block on the rest); every physics-zone collider names its layer's preset; PBR with Scene Linear and ACES, bloom, vignette, white balance, FXAA, FSR at render scale 0.8, ambient occlusion, reflections and volumetrics at 0.5 scale (at the default Medium quality only ambient occlusion runs; reflections and scene-wide volumetric fog need High or Ultra; the Effects zone's Fog Volume renders on every tier); shadows on; render path Auto; WebGL2; dynamic resolution off; Onest as the default font.

### Console commands

| Command | Effect |
| --- | --- |
| `ft_cel` / `ft_pbr` | Switch the shading mode |
| `ft_cluster` / `ft_forward` | Switch the render path |
| `ft_spawn [count]` | Spawn `FT_ScriptSpawned` actors (default 10) |
| `ft_stream` | Toggle loading `FT_StreamedRoom` |
| `ft_stats` | Print score, spinner and spawn counts |

Useful built-ins: `quality low|medium|high|ultra`, `framecap <fps>`, `renderpath auto|forward|clusteredForward`, `fixedlights on|off|multiply|branch`, `possess "<camera name>"`, `stat unit`, `behaviourtreedebug on`, `shownav on`, `showaudiodebug on`.

### Workload knobs

Counts are constants in the area modules; changing one changes performance baselines, so say so in the PR.

| Knob | Default | Module |
| --- | --- | --- |
| `SPINNER_GRID` | 4x4 | `scripting.ts` |
| `FEATURE_TEST_PHYSICS_STRESS` | 8x8x5 = 320 bodies, 6 ragdolls, 32 chain links | `physics.ts` |
| `STRESS_GRID`, `STRESS_CAPACITY`, `STRESS_RATE` | 4 actors x 4096, 2000/s | `particles.ts` |
| `FEATURE_TEST_ANIMATION_STRESS` | 8x8 crowd | `animation.ts` |
| `STRESS_FOLIAGE_GRID` | 72x72 | `world.ts` |
| `LAKE_CAPTURES` | 1 Full Quality capture, 256², every frame (plus its own sun shadow maps each frame) | `world.ts` |
| `GUARD_COUNT` | 4 (crowd cap 32) | `ai.ts` |
| `FEATURE_TEST_SCENE_LAYER_KNOBS` | list 10 000, grid 400, camera tweens 1.5 s | `scene-layers.ts` |
| `CLUSTER_*`, `CAPTURES`, `LOD_DISTANCES` | 48 lights, 3 captures, 5 menorahs | `rendering.ts` |
| `FEATURE_TEST_CAMERA_TOUR` | 22-point loop at 6 m/s | `layout.ts` |

## On-device check and benchmark

The **Feature Test** starter and its check appear only with Engine Settings → Debugger → **Debug Mode** on; e2e routes enable it through `seedEngineSettings`. When a scene fails to load in Debug Mode, **Copy Error** on the Scene Loading dialog copies the failure details.

For devices without a test harness (iPad, phones, other browsers), a Feature Test project's **Debug** menu has **Run Feature Test Check…** (phones: **More Tools** → Debug). It walks the scenes with the editor's own controls and writes a plain-text report; **Copy Report** copies it (the text stays selectable when the clipboard is unavailable).

| Mode | Scenes | Per scene |
| --- | --- | --- |
| Quick | Current Feature Test scene (main otherwise) | Open in the editor and sample viewport frames; Play, sample frames, run `ft_stats`; Stop |
| Full | `main`, `FT_World`, `FT_Clustered`, `FT_2D`, `FT_Stress` | As Quick; the main scene also runs `ft_spawn 10`, `ft_stream`, `ft_cel`, `ft_pbr` |
| Benchmark | All five | Play with the frame cap lifted to 240, then 5 s per profile: `low`, `medium`, `high`, `ultra` on Forward, `high` on Clustered Forward, then `medium` on Forward with fixed-shape lighting (`fixedlights multiply`, then `fixedlights branch`; compare with `medium · forward`; each recompiles every lit shader, so it first waits up to 90 s until the view draws without held frames); fixed-shape lighting, quality, render path and cap are restored afterwards |

- **Report**: app version, device (platform, touch points, pixel ratio, screen, cores, memory), browser and GPU adapter (iPadOS Safari reports a Mac; `MacIntel` with touch points is labelled `iPad (reports MacIntel)`). Per scene: editor and Play load times and where a load stuck (an editor load failure adds its error with cause chain; the GPU line falls back to the viewport's adapter when Play never ran); fps, p95, max frame, stalls over 100 ms; draw calls, mesh and texture counts, CPU/GPU frame cost, render resolution; console command output and duration; Preview Session Report entries; texture counts before and after Play (`LEAK` when textures created during Play are still loaded after release; Babylon's once-per-Engine placeholder textures do not count); Play error/warning lines.
- **Benchmark output**: a per-profile table per scene (quality tiers include their resolution scale, so the resolution column changes between tiers) and the highest Forward tier that holds 60 fps (>= 55 fps, p95 <= 25 ms) and 30 fps (>= 28 fps, p95 <= 45 ms), per scene and across all. A profile the engine could not apply (e.g. Clustered Forward on an orthographic camera) shows `(ran forward)`.
- **Pass/fail**: a scene fails when it does not open or load (120 s each), a command fails or times out (60 s), the session report has an error, or release is not confirmed. While a check runs a small status bar with **Cancel** replaces the dialog and the Preview Session Report dialog is held back (its entries go into the report).
- **Code**: runner [`feature-test-check.ts`](../../apps/editor/src/services/feature-test-check.ts); text report [`feature-test-check-report.ts`](../../apps/editor/src/lib/feature-test-check-report.ts); dialog [`feature-test-check-dialog.tsx`](../../apps/editor/src/components/feature-test-check-dialog.tsx). `FEATURE_TEST_CHECK_SCENES` must name existing scenes (the scaffold gate checks this); a new or renamed Feature Test scene is added there in the same PR.

## Performance testing

The opt-in route `e2e/feature-test-perf-route.spec.ts` runs only through `playwright.perf.config.ts`:

```sh
HAPTIC_PERF_FEATURE_TEST=1 pnpm run test:e2e e2e/feature-test-perf-route.spec.ts \
  --config playwright.perf.config.ts --project perf-software
```

It creates FeatureTest through the real Create dialog, waits for background texture encodes, then for each scene in `HAPTIC_PERF_SCENES` records editor viewport frames, overlay Play frames, tick rate, draw calls, main-thread busy time and long tasks, and times create, scene ready, Play boot and reopen. A scene that shows **Scene Loading Failed** is retried once and counted as `loadRetries`; a second failure fails the run. The JSON report is attached to the test, written to `test-results/perf-route/`, and also to `HAPTIC_PERF_OUT` when set.

| Env | Default | Effect |
| --- | --- | --- |
| `HAPTIC_PERF_SCENES` | `main,stress` | Any of `main`, `stress`, `world`, `clustered`, `2d` |
| `HAPTIC_PERF_SAMPLE_MS` / `HAPTIC_PERF_SAMPLES` | 15000 / 2 | Measurement windows per host |
| `HAPTIC_PERF_WARMUP_MS` / `HAPTIC_PERF_SETTLE_MS` | 10000 / 5000 | Play warm-up and editor settle |
| `HAPTIC_PERF_QUALITY` / `HAPTIC_PERF_FRAMECAP` | project defaults | Play console `quality` (then `quality resolution reset`, so resolution stays fixed) and `framecap` |
| `HAPTIC_PERF_VIEWPORT_CAP` | Engine Settings (30) | Editor viewport frame cap |
| `HAPTIC_PERF_REOPEN` | 1 | `0` skips the reload-and-reopen timing |
| `HAPTIC_PERF_LABEL` / `HAPTIC_PERF_OUT` | none | Free-text label; extra report path that survives the next run |

Rules: compare runs on the same machine, browser project and build only; never assert frame rates. Dynamic resolution is off in FeatureTest projects so the workload stays fixed. Quick smoke: `HAPTIC_PERF_SAMPLES=1 HAPTIC_PERF_SAMPLE_MS=2000 HAPTIC_PERF_WARMUP_MS=2000`. Agents wrap long runs in `pnpm --silent agent:wait local --script test:e2e -- <same arguments>`.

### Fly-through route

`e2e/feature-test-flythrough-route.spec.ts` (opt-in `HAPTIC_PERF_FLYTHROUGH=1`, same config) looks for camera-motion stutter. It creates FeatureTest, optionally switches the project backend and quality in Project Settings, then per scene drives the editor camera along a fixed eye path at fly speed the way the joystick and WASD do (a pose change and camera invalidation per animation frame under a continuous render lease): a static warm-up, then the same path `HAPTIC_FLY_PASSES` times. The test-build hook `__hapticViewportTest.flyThrough` ([`flythrough-probe.ts`](../../apps/editor/src/testing/flythrough-probe.ts)) instruments the Engine for the run only and records every rendered frame: main-thread frame time, eye position, and counters for new Effects, WebGL links and compiles or WebGPU pipelines, shader modules, bind groups, buffers, textures and uploads, material and define invalidations by flag, failed readiness checks, strict readiness probes, graph builds, held frames, shadow generator construction, disposal and moves, enabled-light changes and visible-set churn, plus long tasks and JS heap. The spec ranks spike frames, correlates event kinds with frame cost, groups the event log (with stacks) and, with `HAPTIC_FLY_PROFILE=1`, adds the hottest functions of each spike frame from a CDP CPU profile. Counts are hardware-independent; compare counts across backends and builds, and times only on one machine.

| Env | Default | Effect |
| --- | --- | --- |
| `HAPTIC_PERF_SCENES` | `main,world` | Scenes with a built-in path: `main`, `world`, `clustered`; others need `HAPTIC_FLY_PATH` |
| `HAPTIC_PERF_BACKEND` | project (WebGL2) | `webgl2` or `webgpu`; WebGPU uses the software adapter unless `HAPTIC_RENDER_NATIVE_GPU=1` |
| `HAPTIC_PERF_QUALITY` | starter (Medium) | `low`, `medium`, `high` or `ultra`: the project's Overall Quality, with Dynamic Resolution off; High and Ultra allow the starter's scene-wide Volumetric Lighting |
| `HAPTIC_FLY_SPEED` / `HAPTIC_FLY_PASSES` / `HAPTIC_FLY_WARMUP_MS` | 8 m/s / 2 / 5000 | Fly speed, flights of the path, static hold before the first |
| `HAPTIC_FLY_PATH` | per scene | JSON array of `[x, y, z]` eye waypoints |
| `HAPTIC_FLY_PROFILE` | off | `1` records a CPU profile of the flights |
| `HAPTIC_FLY_PLAY` | none | Selected scenes to fly again in overlay Play with the free camera (`freecam`) |
| `HAPTIC_PERF_SCALING` / `HAPTIC_PERF_VIEWPORT_CAP` | Engine Settings | Hardware scaling level and viewport frame cap |
| `HAPTIC_PERF_SETTLE_MS`, `HAPTIC_PERF_LABEL`, `HAPTIC_PERF_OUT` | 5000, none, none | Settle after opening, label, extra report path |

A switched backend or quality is saved before the first scene opens; scene edits a flight leaves behind are discarded when the next scene opens. On a GPU host (`perf-gpu`), set `HAPTIC_RENDER_NATIVE_GPU=1` so the project's launch arguments are kept. Main-scene Play (`HAPTIC_FLY_PLAY=main`) only loads on a real GPU.

### Cold-load route

`e2e/feature-test-load-route.spec.ts` (opt-in `HAPTIC_PERF_LOAD=1`, same config) measures shader compile work during a cold scene open. It creates FeatureTest, optionally switches the backend, then opens each scene once and records scene-ready time and, from page-level hooks installed before the editor boots (no editor code), every WebGL program link, WebGPU shader module and render pipeline: total, distinct by exact source, and distinct by normalized source (define lines sorted apart from the body, `SHADER_NAME` dropped). An Engine-level ledger records each Babylon Effect with its cache-key kind (named shader, inline source, shadow-depth token (unpatched Babylon)), defines, render pass, creation stack, cache hits, release and the GPU objects it built. The report groups Effects that built the same source and says why their keys differ, lists the define changes that recompiled one shader, and names the live draw wrappers (scene, pass, mesh, material) holding each Effect when the scene is ready; an Effect no wrapper holds was compiled for nothing. It also includes the water compile log. Counts are hardware-independent; never asserts timings.

| Env | Default | Effect |
| --- | --- | --- |
| `HAPTIC_PERF_SCENES` | `main` | Any of `main`, `stress`, `world`, `clustered`, `2d` |
| `HAPTIC_PERF_BACKEND` | project (WebGL2) | `webgl2` or `webgpu`; WebGPU uses the software adapter unless `HAPTIC_RENDER_NATIVE_GPU=1` |
| `HAPTIC_PERF_SETTLE_MS` | 8000 | How long after ready the settled window keeps counting |
| `HAPTIC_PERF_LABEL`, `HAPTIC_PERF_OUT` | none | Label; extra report path |

## Verification

[`apps/editor/src/services/project-service.feature-test.test.ts`](../../apps/editor/src/services/project-service.feature-test.test.ts) (node) creates the project in memory and reopens it. It requires every `ENGINE_COMPONENT_CLASS_IDS` entry (`packages/core/src/engine-components.ts`), every creatable (`CREATABLE_ASSET_TYPES`) and imported asset type, and every `ENGINE_BASE_CLASSES` entry to be present; every dependency to resolve; every document to decode; Play validation to report no errors; every compiled script to load the way Play loads it; every Material and Material Instance to compile; every Particle and Animation Graph to validate; every Scene to open clean (the open-time prefab instance sync leaves it unmodified, so the next Scene opens without an Unsaved Documents prompt); and physics pairing to be clean. Class instances are authored in the form that sync produces, for example both Mesh material override keys. Its browser route is perf-only.

## Known gaps

A feature that cannot be showcased is recorded here with its reason; never skip it silently or weaken the gate.

- Console `quit`: it ends the Play session, so the starter's console workload never runs it.
- Skinned Skeletons and retargeted Animations: the repository has no skinned model (the Mannequin is a hierarchy rig, the door a node animation).
- MSDF font atlases: none exists; text uses the facetype and Onest source Fonts.
- Sprites cut from atlas sub-rects: the Sprite editor preview reads V top-down and the runtime bottom-up, so `FT_2D` Sprites use whole-frame Textures and crates stay Tilemap tiles.
- Color grading waits for a human-supplied CC0 LUT in its slot (Kenney publishes no LUTs).
- Project plugins (PluginSettings): the scaffold host has no plugin API, so no project plugin is authored.
- Environment IBL: no `.env` or prefiltered cube exists in `engine-content`.
- WebGPU is not the default backend because Clustered Forward is WebGL2-only.
- Editor-only by design: Spline drawing (the camera tour still travels its Spline in Play), the EditorFunctionLibrary, BObject classes (not instantiable), and Simulation graph debugging, which adds no authored data: simulate the starter and open any Class, Behaviour Tree or Animation Graph with live instances.
- Physics query channels: the authored queries are the `FT_UIPitCounter` Sphere Overlap Actors on Dynamic and the `FT_ScriptTouchProbe` Project Touch To Scene on the default channel. Line Trace, Sphere Shape Sweep, Project Cursor To Scene and the Static, Character, Solid and Triggers channels are not authored in any zone yet.
- `FT_World` cold open on a real GPU is slow: its Water bodies compile large fragment shaders that ANGLE/D3D11 builds one variant after another, taking many seconds each with an empty shader cache; the loading budgets renew while the driver is still compiling. A view that draws Water through its scene copy compiles only the variants it draws (copy-sampling colour variant and its depth pre-pass, during graph preparation under the `Forward transparent` pass id), but colour and depth still compile sequentially because the depth pre-pass is probed only once the colour variant is ready.
- Main-scene Play on software GL (the `perf-software` project, SwiftShader) does not finish loading in reasonable time; this is the recorded exception to the "first frame on software GL" requirement. Every scene cold-opens within the `SCENE_FIRST_FRAME_TIMEOUT_MS` first-draw budget, and `FT_World`, `FT_Clustered`, `FT_2D` and `FT_Stress` Play load. In main-scene Play the world layer is ready and keeps drawing under the `FT_HUD` layer's loading UI; each frame costs seconds of main-thread time, almost all of it the registered-view canvas copy waiting for SwiftShader, and each HUD slot acquisition re-checks its dependency closure in storage so every storage completion queues behind such a frame. Engine follow-ups: throttle a ready layer while another owner loads; share catalog revision checks between concurrent slot acquisitions. `FT_Stress` Play loads but then runs at one frame every few seconds on software GL.
- Engine follow-ups found while authoring: Scene Layer switcher entries and virtualized-list item classes are not in Play's required closure (the HUD places sample instances as a workaround); BT Play Animation and Play Sound guids are not header dependencies.
