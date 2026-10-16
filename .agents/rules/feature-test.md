# FeatureTest starter

The built-in **Feature Test** starter (`apps/editor/src/lib/feature-test/`) showcases every engine feature and is the default deterministic performance workload. A feature missing from it is unfinished work.

## When this rule applies

Adding, removing, renaming or changing the authored data or runtime behaviour of: an engine component (`ENGINE_COMPONENT_CLASS_IDS` in `packages/core/src/engine-components.ts`) or its properties; a creatable or imported asset type; an engine base class (`ENGINE_BASE_CLASSES`), node or event family, console command or Play feature; project or scene settings; or the starter itself.

## Required in the same PR

1. **Update the scaffold.** Author the feature in the owning area module so it is visible in its zone (or in `FT_World`, `FT_2D`, `FT_HUD`, `FT_Clustered`, `FT_Stress`) and exercised in Play. Changed formats update the authored data; removed features leave the scaffold.
2. **Update [the FeatureTest reference](../reference/feature-test.md)**, the inventory of scenes, zones, performance knobs and known gaps.
3. **Pass the gate:** `apps/editor/src/services/project-service.feature-test.test.ts`, which fails on missing features, unresolved references, undecodable documents and validation errors.
4. **Keep it a fair workload.** Deterministic content (no random values, stable ids); a moderate main scene with heavy load in `FT_Stress`; every scene presents its first frame on software GL (`perf-software`), so move content that breaks the loading deadline into its own scene rather than dropping it. Say in the PR when workload size or render settings change performance baselines.
5. **No generated artwork** ([no-ai-artwork.md](no-ai-artwork.md)): use human-made `engine-content/`, runtime primitives and numeric data. New third-party packs follow the reference's Source content section.
6. A new or renamed Feature Test scene joins `FEATURE_TEST_CHECK_SCENES` in `apps/editor/src/services/feature-test-check.ts`.

If a feature cannot be showcased, record it under **Known gaps** in the reference with the reason; never skip it silently or weaken the gate. Prose-only edits to the reference need only a diff and link review.

Performance comparisons use the opt-in FeatureTest route, and on-device reports come from **Debug > Run Feature Test Check**; both are described in the reference ([performance testing](../reference/feature-test.md#performance-testing), [on-device check](../reference/feature-test.md#on-device-check-and-benchmark)).
