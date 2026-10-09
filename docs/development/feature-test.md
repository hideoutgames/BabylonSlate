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
| Holiday colormap | `Holiday Pack/Textures/colormap.png` | Albedo Texture (KTX2 encode path), Pixel Art copy for Sprites and Tilesets |
| Skybox faces and net | `engine-content/skybox` | Skybox Texture faces, Skybox Creator source |
| Billboards | `engine-content/billboards` | UI Textures |
| Geist | `engine-content/fonts/Geist` (SIL OFL 1.1, `OFL.txt` alongside) | Source Font for overlay text |
| Bundled ASCII glyphs | `@babylonslate/render/default-typeface` | Facetype Font for 3D Text |

### Optional CC0 slots

The repository ships no audio or color grading LUT. Drop CC0 files at these paths and rebuild; new FeatureTest projects pick them up automatically (`vite-engine-content.ts` publishes a `slots.json` manifest):

| Slot | Path | Effect when present |
| --- | --- | --- |
| Loop audio | `engine-content/feature-test/audio/FT_Loop.ogg` (or `.wav`, `.mp3`) | Spatial Audio Components play it |
| One-shot audio | `engine-content/feature-test/audio/FT_OneShot.ogg` (or `.wav`, `.mp3`) | UI and gameplay cues |
| Color grading LUT | `engine-content/feature-test/lut/FT_Grade_lut.png` (strip: width = size², height = size) | Project color grading is enabled |

When a slot is empty the feature stays authored but silent or ungraded.

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

Zones sit on a 32 m grid (`layout.ts`). Each has an Outliner folder and a 3D Text label. The static main camera looks over the three zone rows; the Landscape And Water zone lies further along +Z.

| Zone | Center (x, z) | Area module |
| --- | --- | --- |
| Feature Test (hub) | 0, 0 | `index.ts` (Mannequin, floor) |
| Meshes And Materials | -32, 0 | `materials.ts` |
| Lights And Shadows | 32, 0 | `rendering.ts` |
| Effects | -64, 0 | `rendering.ts` |
| Render Targets | 64, 0 | `rendering.ts` |
| Audio | -64, 32 | `audio.ts` |
| Physics | -32, 32 | `physics.ts` |
| Constraints And Movement | 0, 32 | `physics.ts` |
| Animation | 32, 32 | `animation.ts` |
| Particles | 64, 32 | `particles.ts` |
| Scene Streaming | -64, 64 | `scripting.ts` |
| Scripting | -32, 64 | `scripting.ts` |
| AI And Navigation | 0, 64 | `ai.ts` |
| Model LOD | 64, 64 | `rendering.ts` |
| Landscape And Water | 0, 144 | `world.ts` |

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

- Skinned Skeletons and retargeted Animations: the repository has no skinned model (the Mannequin and the door are hierarchy and node rigs).
- MSDF font atlases: no atlas exists; text uses the facetype and Geist source Fonts.
- Audio playback and LUT grading wait for the optional CC0 slots above.
