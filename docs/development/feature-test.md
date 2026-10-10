# Feature Test project

**Feature Test** is a built-in starter (Create Project → Feature Test, listed in Debug Mode) that showcases every engine feature in one project. It is also the agents' default, deterministic performance workload. Keep it current: [the FeatureTest rule](../../.agents/rules/feature-test.md) requires feature changes to update the scaffold, this page and the scaffold test in the same PR.

## How it is built

- `ProjectService.createEmptyProject(name, { kind: "feature-test" })` runs the Basic 3D scaffold (Input assets, Kenney Mannequin) and then lazily loads `apps/editor/src/lib/feature-test/`.
- `index.ts` runs each area in a fixed order: imports, audio, materials, scripting types, scripting, rendering, physics, world, animation, particles, AI, 2D, Scene Layers. Every referenced asset exists before the asset that uses it. Area modules then place actors in their zones. Scene documents save last (Scene Layers, sub-scenes, scenes, then the main scene), followed by the navmesh bake and project settings.
- Content is deterministic: fixed ids, fixed positions and fixed counts. Only asset guids differ between projects, so tooling finds assets by path or name.
- All assets live under `assets/FeatureTest/<Area>/`, which is an Always Package Folder so Preview Build and export ship the whole showcase.

## Source content

Only existing repository files and runtime primitives are used (no generated artwork):

| Content | Source | Use |
| --- | --- | --- |
| Kenney Mannequin | `engine-content/kenney-assets/Mannequin` (Basic 3D) | Hierarchy Skeleton, 27 clips, animation, ragdoll, crowds |
| Holiday Pack subset | `engine-content/kenney-assets/Holiday Pack` (CC0, `License.txt`, `Source.txt`; list in `engine-content-files.ts`) | Models, foliage, buoyancy, Automatic LOD (menorah), rigid node animation (door) |
| Holiday colormap | `Holiday Pack/Textures/colormap.png` | Albedo Texture (KTX2 encode path), Pixel Art copy for HUD panels and an authored multi-frame Sprite |
| Kenney platformer art | `engine-content/kenney-assets/Platformer` (CC0, Platformer Pack Redux tilesheet and toon robot frames; `License.txt`, `Source.txt`) | `FT_2D` Tilesets, robot Sprites and Sprite Animations |
| Skybox faces and net | `engine-content/skybox` | Skybox Texture faces, Skybox Creator source |
| Billboards | `engine-content/billboards` | UI Textures |
| Geist | `engine-content/fonts/Geist` (SIL OFL 1.1, `OFL.txt` and `Source.txt` alongside; keep `OFL.txt` with any export that ships the font) | Source Font for overlay text |
| Bundled ASCII glyphs | `@babylonslate/render/default-typeface` | Facetype Font for 3D Text |

### Media slots

Audio and the color grading LUT come from human-made CC0 files in fixed slots. New FeatureTest projects pick up whatever is present at build time (`vite-engine-content.ts` publishes a `slots.json` manifest):

| Slot | Path | Shipped | Effect when present |
| --- | --- | --- | --- |
| Loop audio | `engine-content/feature-test/audio/FT_Loop.ogg` (or `.wav`, `.mp3`) | Kenney `upgrade1.wav` | Spatial Audio Components play it |
| One-shot audio | `engine-content/feature-test/audio/FT_OneShot.ogg` (or `.wav`, `.mp3`) | Kenney `coin1.wav` | UI and gameplay cues |
| Color grading LUT | `engine-content/feature-test/lut/FT_Grade_lut.png` (strip: width = size², height = size) | none | Project color grading is enabled |

The Kenney sounds are CC0; `License.txt` and `Source.txt` beside them record the license and origin. Replace a slot file to change the sound; an empty slot leaves the feature authored but silent or ungraded.

## Scenes

| Scene | Path | Purpose |
| --- | --- | --- |
| Main | `assets/main.scene.babasset` | Every 3D feature except the open world, in fixed zones at moderate cost; startup scene and default perf workload |
| FT_Stress | `assets/FeatureTest/Scenes/FT_Stress.scene.babasset` | Heavy, scalable load: physics pile, particle stress, animated crowd, dense foliage |
| FT_World | `assets/FeatureTest/Scenes/FT_World.scene.babasset` | Landscape, Foliage, every water body kind, buoyancy, Cables and Splines |
| FT_Clustered | `assets/FeatureTest/Scenes/FT_Clustered.scene.babasset` | Many unshadowed point lights for Clustered Forward comparisons |
| FT_2D | `assets/FeatureTest/Scenes/FT_2D.scene.babasset` | Sprites, Sprite Animation, Tilemaps and 2D physics |
| FT_StreamedRoom | `assets/FeatureTest/Scenes/FT_StreamedRoom.scene.babasset` | Sub-scene streamed into the main scene |

Open a scene from the Content Browser, or use the console `changescene` command in Play.

## Main scene zones

Zones sit on a 32 m grid (`layout.ts`); each has an Outliner folder and a 3D Text label. The static main camera (`ft-camera-main`) looks over the three zone rows. The scene spawns the `FT_HUD` and `FT_OverlayPhysics` Scene Layers in Play.

| Zone (center x, z) | Module | Contents and what they do |
| --- | --- | --- |
| Feature Test hub (0, 0) | `index.ts` | Basic 3D Mannequin (idle Animation Graph, kinematic capsule) and floor. Scene-wide: texture-face skybox, shadowed sun, post-process entry `FT_MatPostGrade`, exponential fog. |
| Meshes And Materials (-32, 0) | `materials.ts` | Every primitive kind; `FT_MatSurface` (colormap, Material Function tint, pulse), `FT_MatSurfaceInstance` and a chained metal instance, scene-owned instance overrides, `FT_MatEmissive` (scrolling bands), `FT_MatGlass` (translucent, WPO ripple, fresnel), `FT_MatNoiseMasked` (alpha clip). Holiday models keep their slot Materials; one uses a `materialGuid` override. |
| Lights And Shadows (32, 0) | `rendering.ts` | Shadowed spot, shadowed point (cube shadows from a pillar ring), three unshadowed color point lights, unshadowed spot, Area Rect Light, Hemispheric Fill Light. |
| Effects (-64, 0) | `rendering.ts` | Fog Volume around a glowing sphere; x-ray Outline through an occluder wall; lattice Deformer; 3D Text with the facetype Font and the bundled face; Dynamic Runtime Mesh pyramid (`FT_RenderDynamicMesh`, Play only); Spring Arm rig with lag (`FT_RenderSpringArmRig`); orthographic camera `Effects Ortho Camera`. |
| Render Targets (64, 0) | `rendering.ts` | Scene Color (512, every frame), Depth Pass (256, every frame) and World Normal (256, one manual capture by `FT_RenderCaptureManual`) captures of a four-actor subject group (Capture Only Actors), each on a monitor Material sampling its Render Target Texture. |
| Audio (-64, 32) | `audio.ts` | Spatial loop, one-shot cue and looping cue emitters, a muffle wall and a reverb back wall. Channels `FT_AudioMaster` → `FT_AudioWorld` → `FT_AudioCues`; attenuations `FT_AudioNear` and `FT_AudioWide`; `FT_AudioMixer` is the project mixer. Use `possess "Audio Listener Camera"` to hear them. |
| Physics (-32, 32) | `physics.ts` | Box, capsule, convex, cylinder and bouncy sphere bodies; friction ramp; triangle-mesh trough; 15-box stack; rising balloon and damped sphere; `Ghost` collision layer wall; trigger launch pad (`FT_PhysLaunchPad`); kinematic sweeper (`FT_PhysSweeper`). |
| Constraints And Movement (0, 32) | `physics.ts` | Ball-socket pendulum, distance rod, limited hinge, 8-link chain, fixed weld, Mannequin ragdoll, Blocking Volume shelf, two Movement walkers (`FT_PhysWalker`, one hopping). |
| Animation (32, 32) | `animation.ts` | Six Mannequins on `FT_AnimLocomotion` (Idle, Walk, Run, Cheer) driven by `FT_AnimLocomotor` variables; the Holiday door swinging on `FT_AnimDoorSwing` (rigid node animation). |
| Particles (64, 32) | `particles.ts` | `FT_FxShowcase` (Basic emitter plus Particle Graph `FT_FxGlowGraph`), `FT_FxSparks` (additive bursts), `FT_FxSmoke` (local space, Material Instance). |
| Scene Streaming (-64, 64) | `scripting.ts` | `FT_StreamLoader` (SceneStreamingActor with a Scene Streaming Component) streams in `FT_StreamedRoom` 1.5 s after Begin Play. |
| Scripting (-32, 64) | `scripting.ts` | 4 × 4 `FT_ScriptSpinner` grid (enum, structure and tag variables, custom event, interface, subsystem call, static Function Library, input) plus `FT_ScriptSpinnerFast` (inheritance and override); interface, data and save probes; three logic-free `FT_ScriptMarker` Prefab instances. |
| AI And Navigation (0, 64) | `ai.ts` | Baked tile-cache navmesh (bake bounds inside the zone), static, cost and dynamic blockers, four guards on `FT_AIPatrolTree` (every built-in composite, decorator and service, every built-in task except Play Animation and Play Sound, and the custom BT Task, Decorator, Service and Composite classes), and a Mannequin sentry on `FT_AISentryTree` (Play Animation and Play Sound, when a Mannequin clip and the one-shot audio slot exist). |
| Model LOD (64, 64) | `rendering.ts` | Five menorah instances (1150 triangles) at 4 to 48 m from `LOD Lane Camera` for Automatic Model LOD. |

## Other scenes and layers

| Document | Contents |
| --- | --- |
| `FT_Stress` | 320 dynamic bodies over a scaled sweeper, 6 ragdolls and a 32-link chain; 4 stress particle actors (about 16 000 GPU particles); an 8 × 8 animated Mannequin crowd; a 5184-instance foliage carpet. |
| `FT_World` (`world.ts`) | 80 m island Landscape (grass, snow, sand and rock layers, collision), 226 foliage instances, Global Sea at -6 m (object reflections off), Ocean (Ocean Spectrum waves, object reflections), Lake, River and Puddle bodies, Dry Dock removal volume, buoyant presents, seven Cables, two editor Splines; shadowed sun and light fog. It is separate from the main scene because the Ocean on top of every main-scene zone made the main scene miss its loading deadline on software GL. |
| `FT_Clustered` | 48 unshadowed point lights over a plain floor with the engine default sky, so Auto can select Clustered Forward. |
| `FT_2D` | Orthographic camera over a 16 × 9 Tilemap of 128 px Kenney platformer tiles: parallax backdrop, collision ground (grass on dirt, crates, chain ramp, top-edge ledges, animated switch blocks) and a decor layer from a second Tileset (animated water and torches, signs, plants). `FT_2DRobotGraph` cycles robot Idle, Walk, Jump and Fall Sprite Animations on a mascot and a dynamic walking robot; 32 falling robot bodies use every 2D collider shape; chain funnel; hinge pendulum; custom `Characters` sorting layer. |
| `FT_StreamedRoom` | Platform, pillars, sign and a streamed spinner; no camera or lights. |
| `FT_HUD` (Scene Layer) | Every overlay widget: text with the Text-domain Material, rich text, panels, safe area, form controls, scroll box, virtualized list (10 000 rows) and grid (400 cells), mask and mask panel, texture, material swatch, click button (`FT_UIClickButton`), focus target, card switcher (`FT_UICardSwitcher`), joystick bound to Move, persistent painter. Focus navigation uses Confirm. |
| `FT_OverlayPhysics` (Scene Layer) | Eight 2D bodies falling into a pit in the overlay's own physics world. |

## Scripting, data and settings

- **Game Instance** `FT_GameInstance` (Project Settings): logs on init (Output Log); on the first scene it prints the scene name, spawns `FT_ScriptSpawned` when the Scripting zone exists, and runs `ft_stats`. **Subsystems**: `FT_GameScoreSubsystem` (GameSubsystem) and `FT_GameSceneWatcher` (SceneSubsystem).
- **Editor**: `FT_EditorProbe` (EditorUtilityObject, registered) logs editor events; `FT_EditorMath` (EditorFunctionLibrary) is authored only.
- **Types and data**: `FT_ScriptSpeedMode` (Enum), `FT_ScriptSpinConfig` (Structure), `FT_ScriptDescribable` (ScriptInterface), `FT_DataItemStats` / `FT_DataItems` (Data Definition and Data Tree), `FT_DataProgress` (SaveGame, `wipeOnPlay` on).
- **Input**: Basic 3D actions plus `FT_ScriptPulse` (P) and `FT_ScriptNudge` (arrow keys); the HUD joystick adds touch bindings to Move.
- **Project settings**: Feature Test tags, collision layers Default, Dynamic, Trigger, Water, Ghost; PBR with Scene Linear and ACES, bloom, vignette, white balance, FXAA, FSR at render scale 0.8, ambient occlusion, reflections and volumetrics at 0.5 scale; shadows on; render path Auto; WebGL2; dynamic resolution off; Geist as the default font.

### Console commands

| Command | Effect |
| --- | --- |
| `ft_cel` / `ft_pbr` | Switch the shading mode |
| `ft_cluster` / `ft_forward` | Switch the render path |
| `ft_spawn [count]` | Spawn `FT_ScriptSpawned` actors (default 10) |
| `ft_stream` | Toggle loading `FT_StreamedRoom` |
| `ft_stats` | Print score, spinner and spawn counts |

Useful built-ins: `quality low|medium|high|ultra`, `framecap <fps>`, `renderpath auto|forward|clusteredForward`, `possess "<camera name>"`, `stat unit`, `behaviourtreedebug on`, `shownav on`, `showaudiodebug on`.

### Workload knobs

Counts are constants in the area modules; changing one changes performance baselines, so note it in the PR.

| Knob | Default | Module |
| --- | --- | --- |
| `SPINNER_GRID` | 4 × 4 | `scripting.ts` |
| `FEATURE_TEST_PHYSICS_STRESS` | 320 bodies, 6 ragdolls, 32 chain links | `physics.ts` |
| `STRESS_GRID`, `STRESS_CAPACITY`, `STRESS_RATE` | 4 actors × 4096, 2000/s | `particles.ts` |
| `FEATURE_TEST_ANIMATION_STRESS` | 8 × 8 crowd | `animation.ts` |
| `STRESS_FOLIAGE_GRID` | 72 × 72 | `world.ts` |
| `GUARD_COUNT` | 4 (crowd cap 32) | `ai.ts` |
| `FEATURE_TEST_SCENE_LAYER_KNOBS` | list 10 000, grid 400 | `scene-layers.ts` |
| `CLUSTER_*`, `CAPTURES`, `LOD_DISTANCES` | 48 lights, 3 captures, 5 menorahs | `rendering.ts` |

## On-device check and benchmark

The **Feature Test** starter and its check appear only with Engine Settings → Debugger → **Debug Mode** on ([Debug Mode](../architecture/debugger.md)); e2e routes enable it through `seedEngineSettings`. When a scene fails to load in Debug Mode, **Copy Error** on the Scene Loading dialog copies the failure details to send instead.

For devices without a test harness (iPad, phones, other browsers), a Feature Test project's **Debug** menu has **Run Feature Test Check…** (phones: **More Tools** → Debug). It walks the scenes with the editor's own controls and writes a plain-text report; **Copy Report** puts it on the clipboard to paste into a chat or issue. The report text stays selectable when the clipboard is unavailable.

| Mode | Scenes | Per scene |
| --- | --- | --- |
| Quick | Current Feature Test scene (main otherwise) | Open in the editor and sample viewport frames; Play, sample frames, run `ft_stats`; Stop |
| Full | `main`, `FT_World`, `FT_Clustered`, `FT_2D`, `FT_Stress` | As Quick; the main scene also runs `ft_spawn 10`, `ft_stream`, `ft_cel`, `ft_pbr` |
| Benchmark | All five | Play with the frame cap lifted to 240, then 5 s per profile: `low`, `medium`, `high`, `ultra` on Forward and `high` on Clustered Forward; quality, render path and cap are restored afterwards |

- **Report:** app version, device (platform, touch points, pixel ratio, screen, cores, memory), browser and GPU adapter. Per scene it adds:
  - editor and Play load times, plus where a load stuck;
  - fps, p95, max frame and stalls over 100 ms;
  - draw calls, mesh and texture counts, CPU/GPU frame cost and render resolution;
  - console command output and duration;
  - the Preview Session Report entries, texture counts before and after Play (`LEAK` when Play left textures), and Play error/warning lines.
- **Benchmark output:** a per-profile table per scene. Quality tiers include their resolution scale, so the resolution column changes between tiers. It also lists the highest Forward tier that holds 60 fps (at least 55 fps, p95 ≤ 25 ms) and 30 fps (at least 28 fps, p95 ≤ 45 ms), per scene and across all of them. A profile the engine could not apply (for example Clustered Forward on an orthographic camera) shows `(ran forward)`.
- **Pass/fail:** a scene fails when it does not open or load (120 s each), a command fails or times out (60 s), the session report has an error, or release is not confirmed. While a check runs, a small status bar with **Cancel** replaces the dialog, and the Preview Session Report dialog is held back; its entries go into the report instead.
- **Code:** runner `apps/editor/src/services/feature-test-check.ts`; text report `apps/editor/src/lib/feature-test-check-report.ts`; dialog `apps/editor/src/components/feature-test-check-dialog.tsx`. `FEATURE_TEST_CHECK_SCENES` must name existing scenes; the scaffold gate checks this.

## Performance testing

The opt-in route `e2e/feature-test-perf-route.spec.ts` runs only through `playwright.perf.config.ts`:

```sh
BL_PERF_FEATURE_TEST=1 pnpm run test:e2e e2e/feature-test-perf-route.spec.ts \
  --config playwright.perf.config.ts --project perf-software
```

It creates FeatureTest through the Create dialog, waits for background texture encodes, then for each scene in `BL_PERF_SCENES` records editor viewport frames, overlay Play frames, tick rate, draw calls, main-thread busy time and long tasks. It also times create, scene ready, Play boot and reopen. A scene that shows **Scene Loading Failed** is retried once and counted as `loadRetries`; a second failure fails the run. The JSON report is attached to the test, written to `test-results/perf-route/`, and also to `BL_PERF_OUT` when set.

| Env | Default | Effect |
| --- | --- | --- |
| `BL_PERF_SCENES` | `main,stress` | Any of `main`, `stress`, `world`, `clustered`, `2d` |
| `BL_PERF_SAMPLE_MS` / `BL_PERF_SAMPLES` | 15000 / 2 | Measurement windows per host |
| `BL_PERF_WARMUP_MS` / `BL_PERF_SETTLE_MS` | 10000 / 5000 | Play warm-up and editor settle |
| `BL_PERF_QUALITY` / `BL_PERF_FRAMECAP` | project defaults | Play console `quality` (then `quality resolution reset`, so resolution stays fixed) and `framecap` |
| `BL_PERF_VIEWPORT_CAP` | Engine Settings (30) | Editor viewport frame cap |
| `BL_PERF_REOPEN` | 1 | `0` skips the reload-and-reopen timing |
| `BL_PERF_LABEL` / `BL_PERF_OUT` | none | Free-text label; extra report path that survives the next run |

Rules: compare runs on the same machine, browser project and build only; never assert frame rates. Dynamic resolution is off in FeatureTest projects, so the workload stays fixed. A quick smoke run uses `BL_PERF_SAMPLES=1 BL_PERF_SAMPLE_MS=2000 BL_PERF_WARMUP_MS=2000`.

## Verification

`apps/editor/src/services/project-service.feature-test.test.ts` (node) creates the project in memory and reopens it. It requires every `ENGINE_COMPONENT_CLASS_IDS` entry, every creatable and imported asset type, and every `ENGINE_BASE_CLASSES` entry to be present. It also requires every dependency to resolve, every document to decode, Play validation to report no errors, every compiled script to load the way Play loads it, every Material and Material Instance to compile, every Particle and Animation Graph to validate, and physics pairing to be clean.

## Known gaps

- Skinned Skeletons and retargeted Animations: the repository has no skinned model (the Mannequin is a hierarchy rig and the door a node animation).
- MSDF font atlases: none exists; text uses the facetype and Geist source Fonts.
- Sprites cut from atlas sub-rects: the Sprite editor preview reads V top-down and the runtime bottom-up, so `FT_2D` Sprites use whole-frame Textures and crates stay Tilemap tiles.
- Color grading waits for a human-supplied CC0 LUT in its slot (Kenney publishes no LUTs).
- Project plugins (PluginSettings): the scaffold host has no plugin API, so no project plugin is authored.
- Environment IBL: no `.env` or prefiltered cube exists in `engine-content`.
- WebGPU is not the default backend because Clustered Forward is WebGL2-only.
- Editor-only by design: Splines, the EditorFunctionLibrary, and BObject classes (not instantiable).
- Main-scene Play on software GL (the `perf-software` project, SwiftShader) does not finish loading within 20 minutes. Every scene cold-opens within the 20 s `SCENE_FIRST_FRAME_TIMEOUT_MS` first-draw budget, and `FT_World`, `FT_Clustered`, `FT_2D` and `FT_Stress` Play load. In main-scene Play the world layer is ready and keeps drawing under the `FT_HUD` layer's loading UI (`docs/architecture/render.md`). Each frame then costs about 1.7 s of main-thread time, almost all of it the registered-view canvas copy waiting for SwiftShader. Each HUD slot acquisition re-checks its dependency closure in storage, and every storage completion waits behind such a frame. Engine follow-ups: throttle a ready layer while another owner loads, and share catalog revision checks between concurrent slot acquisitions. `FT_Stress` Play loads in about 40 s but then runs at one frame every few seconds on software GL.
- Engine follow-ups found while authoring: Scene Layer switcher entries and virtualized-list item classes are not in Play's required closure (the HUD places sample instances as a workaround); BT Play Animation and Play Sound guids are not header dependencies.
