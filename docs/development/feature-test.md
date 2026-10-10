# Feature Test project

**Feature Test** is a built-in starter (Create Project → Feature Test) that showcases every engine feature in one project. It is also the agents' default, deterministic performance workload. Keep it current: [the FeatureTest rule](../../.agents/rules/feature-test.md) requires feature changes to update the scaffold, this page and the scaffold test in the same PR.

## How it is built

- `ProjectService.scaffoldNewProject("feature-test")` runs the Basic 3D scaffold (Input assets, Kenney Mannequin) and then lazily loads `apps/editor/src/lib/feature-test/`.
- `index.ts` runs each area in a fixed order: imports, audio, materials, scripting types, scripting, rendering, physics, world, animation, particles, AI, 2D, Scene Layers. Every referenced asset exists before the asset that uses it. Area modules then place actors in their zones. Scene documents save last (Scene Layers, sub-scenes, scenes, then the main scene), followed by the navmesh bake and project settings.
- Content is deterministic: fixed ids, fixed positions and fixed counts. Only asset guids differ between projects, so tooling finds assets by path or name.
- All assets live under `assets/FeatureTest/<Area>/`, which is an Always Package Folder so Preview Build and export ship the whole showcase.

## Source content

Only existing repository files and runtime primitives are used (no generated artwork):

| Content | Source | Use |
| --- | --- | --- |
| Kenney Mannequin | `engine-content/kenney-assets/Mannequin` (Basic 3D) | Hierarchy Skeleton, 27 clips, animation, ragdoll, crowds |
| Holiday Pack subset | `engine-content/kenney-assets/Holiday Pack` (CC0; list in `engine-content-files.ts`) | Models, foliage, buoyancy, Automatic LOD (menorah), rigid node animation (door) |
| Holiday colormap | `Holiday Pack/Textures/colormap.png` | Albedo Texture (KTX2 encode path), Pixel Art copy for HUD panels and an authored multi-frame Sprite |
| Kenney platformer art | `engine-content/kenney-assets/Platformer` (CC0, Platformer Pack Redux tilesheet and toon robot frames; `License.txt`, `Source.txt`) | `FT_2D` Tilesets, robot Sprites and Sprite Animations |
| Skybox faces and net | `engine-content/skybox` | Skybox Texture faces, Skybox Creator source |
| Billboards | `engine-content/billboards` | UI Textures |
| Geist | `engine-content/fonts/Geist` (SIL OFL 1.1, `OFL.txt` alongside) | Source Font for overlay text |
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
| Main | `assets/main.scene.babasset` | Every 3D feature in fixed zones at moderate cost; startup scene and default perf workload |
| FT_Stress | `assets/FeatureTest/Scenes/FT_Stress.scene.babasset` | Heavy, scalable load: physics pile, particle stress, animated crowd, dense foliage |
| FT_Clustered | `assets/FeatureTest/Scenes/FT_Clustered.scene.babasset` | Many unshadowed point lights for Clustered Forward comparisons |
| FT_2D | `assets/FeatureTest/Scenes/FT_2D.scene.babasset` | Sprites, Sprite Animation, Tilemaps and 2D physics |
| FT_StreamedRoom | `assets/FeatureTest/Scenes/FT_StreamedRoom.scene.babasset` | Sub-scene streamed into the main scene |

Open a scene from the Content Browser, or use the console `changescene` command in Play.

## Main scene zones

Zones sit on a 32 m grid (`layout.ts`); each has an Outliner folder and a 3D Text label. The static main camera (`ft-camera-main`) looks over the three zone rows; Landscape And Water lies further along +Z. The scene spawns the `FT_HUD` and `FT_OverlayPhysics` Scene Layers in Play.

| Zone (center x, z) | Module | Contents and what they do |
| --- | --- | --- |
| Feature Test hub (0, 0) | `index.ts` | Basic 3D Mannequin (idle Animation Graph, kinematic capsule) and floor. Scene-wide: texture-face skybox, shadowed sun, post-process entry `FT_MatPostGrade`, exponential fog. |
| Meshes And Materials (-32, 0) | `materials.ts` | Every primitive kind; `FT_MatSurface` (colormap, Material Function tint, pulse), `FT_MatSurfaceInstance` and a chained metal instance, scene-owned instance overrides, `FT_MatEmissive` (scrolling bands), `FT_MatGlass` (translucent, WPO ripple, fresnel), `FT_MatNoiseMasked` (alpha clip). Holiday models keep their slot Materials; one uses a `materialGuid` override. |
| Lights And Shadows (32, 0) | `rendering.ts` | Shadowed spot, shadowed point (cube shadows from a pillar ring), three unshadowed color point lights, unshadowed spot, Area Rect Light, Hemispheric Fill Light. |
| Effects (-64, 0) | `rendering.ts` | Fog Volume around a glowing sphere; x-ray Outline through an occluder wall; lattice Deformer; 3D Text with the facetype Font and the bundled face; Dynamic Runtime Mesh pyramid (`FT_RenderDynamicMesh`, Play only); Spring Arm rig with lag (`FT_RenderSpringArmRig`); orthographic camera `Effects Ortho Camera`. |
| Render Targets (64, 0) | `rendering.ts` | Scene Color (512, every frame), Depth Pass (256, every frame) and World Normal (256, one manual capture by `FT_RenderCaptureManual`) captures, each on a monitor Material sampling its Render Target Texture. |
| Audio (-64, 32) | `audio.ts` | Spatial loop, one-shot cue and looping cue emitters, a muffle wall and a reverb back wall. Channels `FT_AudioMaster` → `FT_AudioWorld` → `FT_AudioCues`; attenuations `FT_AudioNear` and `FT_AudioWide`; `FT_AudioMixer` is the project mixer. Use `possess "Audio Listener Camera"` to hear them. |
| Physics (-32, 32) | `physics.ts` | Box, capsule, convex, cylinder and bouncy sphere bodies; friction ramp; triangle-mesh trough; 15-box stack; rising balloon and damped sphere; `Ghost` collision layer wall; trigger launch pad (`FT_PhysLaunchPad`); kinematic sweeper (`FT_PhysSweeper`). |
| Constraints And Movement (0, 32) | `physics.ts` | Ball-socket pendulum, distance rod, limited hinge, 8-link chain, fixed weld, Mannequin ragdoll, Blocking Volume shelf, two Movement walkers (`FT_PhysWalker`, one hopping). |
| Animation (32, 32) | `animation.ts` | Six Mannequins on `FT_AnimLocomotion` (Idle, Walk, Run, Cheer) driven by `FT_AnimLocomotor` variables; the Holiday door swinging on `FT_AnimDoorSwing` (rigid node animation). |
| Particles (64, 32) | `particles.ts` | `FT_FxShowcase` (Basic emitter plus Particle Graph `FT_FxGlowGraph`), `FT_FxSparks` (additive bursts), `FT_FxSmoke` (local space, Material Instance). |
| Scene Streaming (-64, 64) | `scripting.ts` | `FT_StreamLoader` (SceneStreamingActor with a Scene Streaming Component) streams in `FT_StreamedRoom` 1.5 s after Begin Play. |
| Scripting (-32, 64) | `scripting.ts` | 4 × 4 `FT_ScriptSpinner` grid (enum, structure and tag variables, custom event, interface, subsystem call, static Function Library, input) plus `FT_ScriptSpinnerFast` (inheritance and override); interface, data and save probes; three logic-free `FT_ScriptMarker` Prefab instances. |
| AI And Navigation (0, 64) | `ai.ts` | Baked tile-cache navmesh (bake bounds inside the zone), static, cost and dynamic blockers, four guards on `FT_AIPatrolTree` (every built-in node plus the custom BT Task, Decorator, Service and Composite classes), and a Mannequin sentry on `FT_AISentryTree`. |
| Model LOD (64, 64) | `rendering.ts` | Five menorah instances (1150 triangles) at 4 to 48 m from `LOD Lane Camera` for Automatic Model LOD. |
| Landscape And Water (0, 144) | `world.ts` | 80 m island Landscape (grass, snow, sand and rock layers, collision), 226 foliage instances, Global Sea at -6 m, Ocean, Lake, River and Puddle bodies, Dry Dock removal volume, buoyant presents, seven Cables, two editor Splines. |

## Other scenes and layers

| Document | Contents |
| --- | --- |
| `FT_Stress` | 320 dynamic bodies over a scaled sweeper, 6 ragdolls and a 32-link chain; 4 stress particle actors (about 16 000 GPU particles); an 8 × 8 animated Mannequin crowd; a 5184-instance foliage carpet. |
| `FT_Clustered` | 48 unshadowed point lights over a plain floor with the engine default sky, so Auto can select Clustered Forward. |
| `FT_2D` | Orthographic camera over a 16 × 9 Tilemap of 128 px Kenney platformer tiles: parallax backdrop, collision ground (grass on dirt, crates, chain ramp, top-edge ledges, animated switch blocks) and a decor layer from a second Tileset (animated water and torches, signs, plants). `FT_2DRobotGraph` cycles robot Idle, Walk, Jump and Fall Sprite Animations on a mascot and a dynamic walking robot; 32 falling robot bodies use every 2D collider shape; chain funnel; hinge pendulum; custom `Characters` sorting layer. |
| `FT_StreamedRoom` | Platform, pillars, sign and a streamed spinner; no camera or lights. |
| `FT_HUD` (Scene Layer) | Every overlay widget: text with the Text-domain Material, rich text, panels, safe area, form controls, scroll box, virtualized list (10 000 rows) and grid (400 cells), mask and mask panel, texture, material swatch, click button (`FT_UIClickButton`), focus target, card switcher (`FT_UICardSwitcher`), joystick bound to Move, persistent painter. Focus navigation uses Confirm. |
| `FT_OverlayPhysics` (Scene Layer) | Eight 2D bodies falling into a pit in the overlay's own physics world. |

## Scripting, data and settings

- **Game Instance** `FT_GameInstance` (Project Settings): prints on init, spawns `FT_ScriptSpawned` on the first scene and runs `ft_stats`. **Subsystems**: `FT_GameScoreSubsystem` (GameSubsystem) and `FT_GameSceneWatcher` (SceneSubsystem).
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

## Performance testing

The opt-in route `e2e/feature-test-perf-route.spec.ts` runs only through `playwright.perf.config.ts`:

```sh
BL_PERF_FEATURE_TEST=1 pnpm run test:e2e e2e/feature-test-perf-route.spec.ts \
  --config playwright.perf.config.ts --project perf-software
```

It creates FeatureTest through the Create dialog, waits for background texture encodes, then for each scene in `BL_PERF_SCENES` records editor viewport frames, overlay Play frames, tick rate, draw calls, main-thread busy time and long tasks. It also times create, scene ready, Play boot and reopen. The JSON report is attached to the test, written to `test-results/perf-route/`, and also to `BL_PERF_OUT` when set.

| Env | Default | Effect |
| --- | --- | --- |
| `BL_PERF_SCENES` | `main,stress` | Any of `main`, `stress`, `clustered`, `2d` |
| `BL_PERF_SAMPLE_MS` / `BL_PERF_SAMPLES` | 15000 / 2 | Measurement windows per host |
| `BL_PERF_WARMUP_MS` / `BL_PERF_SETTLE_MS` | 10000 / 5000 | Play warm-up and editor settle |
| `BL_PERF_QUALITY` / `BL_PERF_FRAMECAP` | project defaults | Play console `quality` and `framecap` |
| `BL_PERF_VIEWPORT_CAP` | Engine Settings (30) | Editor viewport frame cap |
| `BL_PERF_REOPEN` | 1 | `0` skips the reload-and-reopen timing |
| `BL_PERF_LABEL` / `BL_PERF_OUT` | none | Free-text label; extra report path that survives the next run |

Rules: compare runs on the same machine, browser project and build only; never assert frame rates. Dynamic resolution is off in FeatureTest projects, so the workload stays fixed. A quick smoke run uses `BL_PERF_SAMPLES=1 BL_PERF_SAMPLE_MS=2000 BL_PERF_WARMUP_MS=2000`.

## Verification

`apps/editor/src/services/project-service.feature-test.test.ts` (node) creates the project in memory and reopens it. It requires every `ENGINE_COMPONENT_CLASS_IDS` entry, every creatable and imported asset type, and every `ENGINE_BASE_CLASSES` entry to be present. It also requires every dependency to resolve, every document to decode, Play validation to report no errors, and physics pairing to be clean.

## Known gaps

- Skinned Skeletons and retargeted Animations: the repository has no skinned model (the Mannequin is a hierarchy rig and the door a node animation).
- MSDF font atlases: none exists; text uses the facetype and Geist source Fonts.
- Sprites cut from atlas sub-rects: the Sprite editor preview reads V top-down and the runtime bottom-up, so `FT_2D` Sprites use whole-frame Textures and crates stay Tilemap tiles.
- Color grading waits for a human-supplied CC0 LUT in its slot (Kenney publishes no LUTs).
- Project plugins (PluginSettings): the scaffold host has no plugin API, so no project plugin is authored.
- Environment IBL: no `.env` or prefiltered cube exists in `engine-content`.
- WebGPU is not the default backend because Clustered Forward is WebGL2-only.
- Editor-only by design: Splines, the EditorFunctionLibrary, and BObject classes (not instantiable).
- Engine follow-ups found while authoring: Scene Layer switcher entries and virtualized-list item classes are not in Play's required closure (the HUD places sample instances as a workaround); BT Play Animation and Play Sound guids are not header dependencies.
