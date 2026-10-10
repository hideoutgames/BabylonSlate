# FeatureTest starter

The built-in **Feature Test** starter (`apps/editor/src/lib/feature-test/`) showcases every engine feature and is the agents' default deterministic performance workload. It must stay complete and current; a feature missing from it is unfinished work.

## When this rule applies

Any change that adds, removes, renames, or changes the authored data or runtime behavior of something a project can author or a player can see:

- an engine component (`ENGINE_COMPONENT_CLASS_IDS` in `packages/core/src/engine-components.ts`) or its properties;
- an asset type: creatable (`CREATABLE_ASSET_TYPES`) or imported (Texture, Model, Skeleton, Animation, Material, Font, Audio);
- an engine base class (`ENGINE_BASE_CLASSES`), node or event family, console command, or Play/Preview feature;
- project or scene settings (render, effects, quality, physics, 2D, audio, input, save game, tags, fonts);
- `apps/editor/src/lib/feature-test/**`, the starter wiring, or [the FeatureTest doc](../../docs/development/feature-test.md).

## Required in the same PR

1. **Update the scaffold.** Change the owning area module in `apps/editor/src/lib/feature-test/` so the feature is authored, visible in its zone (or in `FT_World`, `FT_2D`, `FT_HUD`, `FT_Clustered`, `FT_Stress`), and exercised in Play. A new feature gets a showcase; a changed data format updates the authored data; a removed feature is deleted from the scaffold.
2. **Update the doc.** [docs/development/feature-test.md](../../docs/development/feature-test.md) is the maintained inventory: what each scene and zone contains, what it does, performance knobs, and known gaps.
3. **Run the gate.** `apps/editor/src/services/project-service.feature-test.test.ts` (targeted) fails when a component, asset type, or base class is missing, a reference does not resolve, a document does not decode, Play validation reports an error, a compiled script does not load, a Material does not compile, a Particle or Animation Graph fails validation, or physics pairing is invalid.
4. **Keep it a fair workload.** Content stays deterministic (no random values, stable ids). The main scene stays moderate and representative; heavy scalable load goes in `FT_Stress`. Every scene must present its first frame on software GL (the `perf-software` project); when an addition pushes a scene past the loading deadline, move that content to its own scene, as `FT_World` does, rather than dropping the feature. Main-scene Play is the recorded exception (Known gaps) until the engine follow-ups listed there land. Changing workload size or render settings changes performance baselines, so say so in the PR.
5. **No generated artwork.** Use human-made files in `engine-content/`, runtime primitives, and numeric data ([no-ai-artwork.md](no-ai-artwork.md)). A new third-party pack must be human-made and CC0 (fonts: OFL), ship its `License.txt` (or `OFL.txt`) and `Source.txt` beside it, and be listed in the doc's Source content table. Optional CC0 audio and LUT files enter through the documented media slots.

Prose-only edits to the FeatureTest doc need the diff and link checks from [AGENTS.md](../../AGENTS.md), not the scaffold gate.

If a feature cannot be showcased (for example, it needs art the repository lacks), record it under **Known gaps** in the doc with the reason. Do not skip it silently or weaken the gate.

## Performance testing

Use FeatureTest for performance comparisons during development: the opt-in route `e2e/feature-test-perf-route.spec.ts` (`BL_PERF_FEATURE_TEST=1`, `playwright.perf.config.ts`) creates the starter through the real Create dialog and records editor and Play timings. Compare runs on the same machine and build settings only, and never assert a frame rate. See [the FeatureTest doc](../../docs/development/feature-test.md#performance-testing).

On real devices (iPad, phones), users run **Debug → Run Feature Test Check…** (Quick, Full or Benchmark) and paste its text report; read it with [the doc's report section](../../docs/development/feature-test.md#on-device-check-and-benchmark). A new or renamed Feature Test scene must be added to `FEATURE_TEST_CHECK_SCENES` in `apps/editor/src/services/feature-test-check.ts` in the same PR.
