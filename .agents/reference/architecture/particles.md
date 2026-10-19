# Particles

Basic Particle Emitter, Particle Graph and Particle System assets, `ParticleComponent`, and the main-thread `ParticleService` that runs them on Babylon particle systems.

## Decisions

- Wrap Babylon `GPUParticleSystem` / `ParticleSystem` as **billboard quads only** (`isBillboardBased = true`). No custom simulator or tick, thin-instance particles, SPS, points cloud, fluid renderer, mesh particles or second renderer. Never use the Node Particle Editor UI, snippets, `ParticleHelper` or Babylon JSON (`ParticleSystem.serialize()` / `NodeParticleSystemSet.serialize()`) as payloads: those are Babylon-owned formats with unstable block ids.
- Own the schemas Babylon-free (`assets`, `particle-graph`), then **apply** (Basic) or **lower** (Particle Graph) onto a live system in `render`.
- Two emitter kinds: **Basic** is a module stack with no scripting, GPU first; **Particle Graph** is our own node IR lowered onto Babylon Node Particle blocks for custom per-particle logic. A **Particle System** plays up to 8 slots of either kind on one actor.
- GPU/CPU is chosen **per emitter**. Basic uses `GPUParticleSystem` (`emitRateControl: true`) when the owning engine has compute or transform feedback, else CPU capped at 512. Graphs are always CPU: Babylon's node path only builds `ParticleSystem` and the GPU update shader has no custom-code hook. Graph documents never store a backend, so a GPU tier can follow without a format change. Auto-tiering and a custom GPU graph compiler were rejected.
- The look is a **particle-domain Material**; emitters have no Texture field (one look path). Textures are sampled in the Material ([shader-graph.md](shader-graph.md)). No default Material or Texture ships (no generated artwork): an emitter without a usable Material does not render.
- Units are **seconds**: `updateSpeed = PARTICLE_UPDATE_SPEED` (1/60). Babylon's default 0.01 made one unit about 1.67 s.
- Blend and billboard ids map to Babylon constants **by name** in [`particle-render-modes.ts`](../../../packages/render/src/particle-render-modes.ts), never repo-local numbers (an earlier numeric table swapped ONEONE and STANDARD).
- **No migration** (unreleased): header versions stay 1; `schemaVersion` is a payload field; normalizers read only the current shape and fill defaults, so old assets may change look.
- Lifecycle (Loop, Duration, Pre Warm) belongs to each emitter; the System owns slots, Space and Preview Skybox.
- Out of scope: sprite-sheet flipbooks, noise, flow maps, sub-emitters and triggers, mesh/custom emitters, `textureMask`, ramp/remap gradients, a particle-age material node, attractors in Basic, script-settable graph parameters, live particles in the edit-mode viewport.

## Ownership

| Area | Source |
| --- | --- |
| Shared ids and budgets (capacity 16–4096, CPU budget 512, 8 slots, 2–8 curve keys, `particlePrewarmSteps`) | [`packages/core/src/particle-settings.ts`](../../../packages/core/src/particle-settings.ts) |
| Basic schema and plan (`resolveBasicEmitterPlan`), value specs, burst schedule | [`packages/assets/src/`](../../../packages/assets/src/) `particle-basic-emitter.ts`, `particle-values.ts`, `particle-schedule.ts` |
| `ParticleLibrary`, `particleLibraryFromAssets`, `particleLibraryEmitterKey` | [`particle-library.ts`](../../../packages/assets/src/particle-library.ts) |
| Particle Graph document, catalog, validator, lowering, compile key, canvas adapter | [`packages/particle-graph/src/`](../../../packages/particle-graph/src/) (depends only on `core`) |
| `ParticleService`, factory, emission driver, graph realisation | [`packages/render/src/`](../../../packages/render/src/) `particle-service.ts`, `particle-system-factory.ts`, `particle-emission-driver.ts`, `particle-graph-realize.ts`, `particle-graph-blocks.ts`, `particle-material.ts` |
| Editors and preview | [`apps/editor/src/panels/`](../../../apps/editor/src/panels/) `particle-*-panels.tsx`, [`particle-graph-editing-context.tsx`](../../../apps/editor/src/context/particle-graph-editing-context.tsx), [`particle-preview-canvas.tsx`](../../../apps/editor/src/components/particle-preview-canvas.tsx) |

## Assets

| Asset | Type, suffix | Payload | Dependencies |
| --- | --- | --- | --- |
| Basic Particle Emitter | `ParticleEmitter`, `.emitter.babasset` | `schemaVersion: 2` module stack | Its Material |
| Particle Graph | `ParticleGraph`, `.particlegraph.babasset` | `schemaVersion: 1` graph + settings | Its Material |
| Particle System | `ParticleSystem`, `.particles.babasset` | `emitterGuids` (≤ 8, ordered, duplicates allowed), `space` (`world`/`local` → `isLocal` on every slot), `previewSkybox` | Its emitters |

- The registry runs no normalizer at v1, so every read site normalizes (Play/preview `particleLibraryFromAssets`, player hydrate, Inspector).
- `ParticleComponent`: `particleSystemGuid`, `playOnStart`, sorting layer/order. The sorting layer maps to `renderingGroupId`; `applySortingToParticleSystem` keeps `scene.particleSystems` in sort-key order because Babylon draws a group's systems in list order.
- `particleLibraryEmitterKey` keys a graph by compile key + `materialGuid`, so node moves and renames never rebuild.

## Basic Particle Emitter

- Stages: Emitter (Material, Capacity, Loop, Duration, Pre Warm) → Spawn (Rate, Bursts) → Shape (Point, Box, Sphere, Hemisphere, Cylinder, Cone) → Initialize (Lifetime, Speed, Size, Color, Scale, Rotation) → Over Life (Speed Over Life, Speed Limit, Drag) → Forces (Gravity) → Render (Blend Mode, Billboard). Toggle modules keep their values while off.
- Values are Constant, Random Range or Curve (colors: Gradient), 2–8 keys. `PARTICLE_VALUE_SPECS` / `PARTICLE_COLOR_SPEC` are the one table of modes, ranges and units the normalizer, plan and editor read. Mode switches keep the look.
- Rate and Lifetime curves run over the **emitter cycle** and the service writes them each frame; `addEmitRateGradient` / `addLifeTimeGradient` / `addStartSizeGradient` are never called because they throw on looping systems. Other curves run over **particle age** as Babylon gradients. Color is always a color gradient.
- Bursts: Babylon has no schedule, so the emission driver queues `manualEmitCount` after each frame (bursts fire **one frame late**, never during prewarm) and restores `-1` afterwards. The plan caps a burst at the running capacity; the stored Count is not capped.
- The GPU system claims its whole slot ring after construction and `reset()` so overlapping bursts do not overwrite live particles; a layout guard throws `Unsupported Babylon GPU particle layout` after an incompatible upgrade (re-derive, never relax). At capacity GPU recycles the oldest, CPU drops new ones.
- Pre Warm is Infinite-only (Babylon advances a Once emitter's stop clock during prewarm): `preWarmCycles = min(60, ceil(s × 30))`.

## Particle Graph

- Document settings (not nodes): `materialGuid`, capacity 16–4096 (no 512 cap; `cpuBudget` warning), loop, duration, prewarm, blend, billboard. No Space, no backend. Exactly one protected **Emitter Output** (never called "System").
- Types: Float, Vector 2, Vector 3, Color, Particle; no Int. Babylon's Float splat is the only implicit conversion.
- **Spine:** Particle pins carry the system Create Particle → Shape → Update → Emitter Output and take one link; a Particle output feeds one input (`spineFanOut`), because a second branch is never built. The canvas rewires rather than refuses.
- Emit Rate has no particle: per-particle reads, Per Particle Random or system positions there are errors (`perParticleInEmitRate`).
- Reserved ids (`PARTICLE_UNSUPPORTED_V1_TYPES`) report `particle.unsupportedNode`, so later versions enable them without renames. Every node carries a `role` for its header colour.
- `lowerParticleGraphDocument` walks back from Emitter Output in catalog pin order. `particleGraphCompileKey` excludes positions, name, `materialGuid` and unreachable nodes. Documents are replaced, never edited in place (the cached lowering depends on it).
- `realizeParticleGraph` builds synchronously inside `ParticleService.prepare`: blocks are constructed with `new` (never `Parse`, snippets, `setToDefault` or `buildAsync`) into one fresh `NodeParticleSystemSet` per slot; settings go on the `SystemBlock` before the build. `SlateSystemBlock` seeds Babylon's uninitialised `_buildId` so shared value nodes build once. `ParticleSystemSet.emitterNode` is never used (its dispose would destroy the actor's emitter mesh).
- Local Space lowers Apply Velocity through `LocalPositionUpdated` (node-built systems skip Babylon's local step). Position, Emitter Position, Attractor and radial shape directions stay world-space.
- Build failures report `particle.compile.{unsupportedNode,typeMismatch,connectionFailed,buildFailed}` anchored to the node; the set and partial system are disposed.

## Look

- `bindParticleMaterial` waits for the NodeMaterial build, then `createEffectForParticles`. Particle-mode Materials are not rebuilt when a sampled texture loads (their effects bind textures per draw; a rebuild drops the draw on WebGPU).
- Babylon's `isReady()` needs a ready `particleTexture`, so each native system owns a 1×1 white `slate:particleReadiness` texture that no shader samples.
- Blend: Additive (`additive`, ONEONE, default), Normal (`standard`), Alpha Additive (`add`), Multiply, Subtract. Only ONEONE and MULTIPLY effects compile; the others reuse ONEONE under their own alpha state. Billboard: Camera Facing (`all`), Y Axis, Stretched.
- Particle textures encode KTX2 at block-aligned (multiple of 4) sizes because WebGPU rejects unaligned ASTC/BC7 ([asset-registry.md](asset-registry.md)).

## Runtime

- `ParticleService` is the main-thread owner for overlay Play, the player and previews; the worker never imports Babylon and graphs emit only `assignParticle` / `setParticlePlaying`. Script nodes: `particles.play` / `particles.stop` (Actor defaults to self).
- Each slot is one native system whose `emitter` is an enabled geometry-less `particleEmitter:<key>` mesh parented to the actor. A hidden emitter hides its particles because FrameGraph culling drops it.
- A failure skips and disposes only its slot (`particle.unknown_emitter`, `particle.missing_material`, `particle.graph_invalid`, `particle.compile.*`, `particle.apply_failed`); only readiness timeout, a throw outside a slot, or no playable slot fails the entry. `particle.unknown_system` skips playback.
- Readiness waits are stall bounds, not durations (`boundParticlePreparation`; [render.md](render.md#loading-and-readiness)): 4 s without progress, not charged for a thread held by a synchronous shader link, renewed while shaders finish on the Engine, ending at the preparation ceiling. A Material that stalls its bind skips its slot; a bundle whose slots stay unready fails with `particle.apply_failed` and the shader counts.
- Lifecycle: incarnation + generation per component; Play is idempotent while preparing/playing; Stop drains (CPU by live count, GPU by a conservative lifetime bound; no GPU readback). Pause sets `updateSpeed = 0` (graphs also set `paused`); systems readied while paused start on resume. Play close, `changescene`, despawn and a null `assignParticle` retire immediately; `stats().systems` must return to 0.
- `updateLibrary` applies change tiers (`none`, `live`, `respawn`, `rebuild`; graphs: Material change is `live`, compile-key change rebuilds only that slot). Previews debounce heavier tiers (`PARTICLE_PREVIEW_EDIT_DEBOUNCE_MS`) and keep a graph's last valid build while it has errors.
- Previews run a `"local"`-stats `ParticleService` on a disposable Scene on the app-lifetime Engine (RTT + 2D blit). Play takes emitters and Systems from open tabs first; export packs all three types and the player hydrates them with `particleLibraryFromAssets`.
- Babylon patch dependencies (shader language through particle effect recreation, GPU `paused`): [render.md](render.md#babylon-pin-and-workarounds).
