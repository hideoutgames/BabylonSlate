# Particles

P17 wraps Babylon `GPUParticleSystem` / `ParticleSystem` as **billboard quads only**. Spec: [engineplan.md](../engineplan.md) §2.7. Live Babylon docs: `/features/featuresDeepDive/particles`.

## Why wrap Babylon

`GPUParticleSystem` (WebGL2 transform feedback; default on the A16 iPad) and `ParticleSystem` (CPU animate, GPU draw) already render plane particles: `particleTexture`, shape emitters, lifetime gradients, `isLocal`, pre-warm, `targetStopDuration`, `blendMode`, `billboardMode`. Look is `NodeMaterial.createEffectForParticles(system)` in **Particle** mode.

Do **not** write a custom thin-instance simulator, Solid Particle System, points cloud, fluid renderer, mesh particles, or `MeshParticleEmitter`. Do **not** wrap Node Particle Editor or `ParticleHelper` snippets. Do **not** store Babylon `ParticleSystem.serialize()` as the `.babasset` payload. Own schema in `@babylonslate/assets`, then **apply** onto a live `IParticleSystem` in `@babylonslate/render`.

**Quads only.** `isBillboardBased = true`, `BILLBOARDMODE_ALL`. No second renderer.

## Assets

| Asset | File | Role |
| --- | --- | --- |
| Particle Emitter | `.emitter.babasset` | One `IParticleSystem` recipe: Texture, optional particle-domain Material, capacity, rate, shape, lifetime, single-value gradients, gravity, blend. No mesh guid. |
| Particle System | `.particles.babasset` | Ordered Emitter guids (duplicates allowed, max 8). Runtime starts one Babylon system per slot on the same actor. |

`ParticleComponent` references a Particle System. `playOnStart`, sorting layer/order. Actor transform is `IParticleSystem.emitter`. Sorting layer maps onto Babylon `renderingGroupId` (Background / world / Foreground / UI). Particle systems have no mesh `alphaIndex`; `orderInLayer` is stored and forwarded on `assignParticle` for component parity.

## Authoring

- **New Asset → Rendering**: Particle Emitter (`.emitter.babasset`) and Particle System (`.particles.babasset`).
- DockView **Preview** + **Details** (Sprite-style). Windows toggles those tabs. **Loading Preview** overlays the canvas until the first `present()`. After boot, skipped emitters show **No Texture** or **Missing Emitter** (catalog Empty) instead of a black canvas. Emitter Preview with no Texture guid shows **No Texture**. With a Texture guid, Preview runs `GPUParticleSystem` (CPU fallback) on the Material-Preview-style disposable Scene (app-lifetime Engine, RTT + 2D blit, never a second Engine). Preview compiles an optional particle-domain Material and calls `createEffectForParticles`.
- **System Preview** loads each slot's Particle Emitter **document** payload (open tab first, else `loadAssetDocument`). Registry `header.payload` is empty for Emitters (`headerMetaForSave` has no Particle case) — do not treat `{}` as authored look.
- Failed emitter-document or texture reads and renderer startup show **Preview Failed** with **Retry** and guidance to check linked assets in Details. Runtime diagnostic overlays keep the preview canvas mounted so editing an asset or retrying can restart it. Failed attempts release their disposable preview resources before retrying; the shared Engine stays alive.
- System Preview defaults to the engine cubemap (`createSkyboxMesh` + `createEngineDefaultCubeTexture`, not `scene.createDefaultSkybox`). Details boolean **Preview Skybox** (`previewSkybox`, schema v1, missing → true) is editor-only and ignored at runtime. Emitter Preview stays the near-black studio.
- Lucide `Sparkles` (Particle System / ParticleComponent) and `Wind` (Particle Emitter); family color matches Material.
- **Place Actors → Particles** and **Place Actors → Project** Particle System spawn `ParticleComponent`. Engine Particle stays empty until a System is picked.
- Add Component / Search: `ParticleComponent` (`particleSystemGuid`, play-on-start, sorting layer/order).
- Editor viewport uses a camera-facing billboard helper (`billboard:particle`), same as audio/light/camera. Play hides that helper (`meshKind: "particle"`).

Emitter Details: Texture, optional particle-domain Material (AssetPicker filters `domain === "particle"`), capacity 16–4096, emit rate, blend Standard/Additive, shape point/box/sphere/cone, lifetime/speed/size min/max, gravity, color start/end (RGB + alpha), angular speed, pre-warm cycles. Look lives here — do not duplicate Emitter fields onto System slots.

System Details: space world/local, looping, duration, up to 8 Emitter slots (duplicates allowed), **Preview Skybox**.

## GPU-safe authored surface

Construct `GPUParticleSystem` when the owning engine supports transform feedback or compute, with `emitRateControl: true`; else `ParticleSystem` with `min(capacity, 512)`. Capacity default 256, clamp 16–4096.

Author only the shared CPU/GPU surface: `emitRate`; `createPointEmitter` / `createBoxEmitter` / `createSphereEmitter` / `createConeEmitter`; `minLifeTime` / `maxLifeTime`; `minEmitPower` / `maxEmitPower`; `gravity`; `minSize` / `maxSize` plus single-value `addSizeGradient` / `addColorGradient` (2–8 keys); angular speed **or** one `addAngularSpeedGradient` (gradient wins when both are authored); optional `addDragGradient` (0 and 1 keys); `blendMode` Standard / Additive; `isLocal`; looping vs `targetStopDuration`; capped `preWarmCycles`.

GPU `stop()` stops emission while existing particles drain; the owner retires native resources after its simulation-time lifetime bound. Do not author sub-emitters, bursts (`manualEmitCount`), `disposeOnStop`, dual min/max gradient values, emit-rate / start-size gradients, `textureMask`, or mesh emitters.

Always set `system.particleTexture` from the Emitter Texture guid (an owned texture lease with `invertY: false` and `hasAlpha: true`). Before `createEffectForParticles`, copy that texture onto every `ParticleTextureBlock` on the particle-domain NodeMaterial so the effect does not sample Babylon's empty/error checker. An NME Particle Texture preview node is not a second source of truth — live sampling is `system.particleTexture`.

## Particle-domain materials

`createEffectForParticles` requires `NodeMaterialModes.Particle`. Material `domain: "particle"` sits beside `surface` | `postProcess` | `interface`.

| Node | Kind | Babylon |
| --- | --- | --- |
| Particle Color | `input.particleColor` | `particle_color` attribute (`ParticleColorBlock` in NME; Babylon 9 has no class) |
| Particle Texture | `input.particleTexture` | `ParticleTextureBlock` (live sample is `system.particleTexture`) |

Shared math / Mix / Combine stay legal. Hide world attributes, WPO, PBR metallic, Normal Map, post-process buffers. Terminal is fragment color/alpha only (no `output.surface`). Emitter AssetPicker filters `domain === "particle"`. Missing material = Babylon default `texture * particleColor`. Particle blend is `IParticleSystem.blendMode`, not MeshComponent `blendMode`.

## Runtime

`ParticleService` in `@babylonslate/render` is Audio-shaped: main thread, worker never imports Babylon. Commands: `assignParticle` / `setParticlePlaying`. Each Particle System slot becomes one Babylon `GPUParticleSystem` (or CPU `ParticleSystem`). The Babylon `emitter` is an **enabled** mesh parented to the actor origin (`isVisible = true`, `visibility = 0`, `alwaysSelectAsActiveMesh`, not pickable). Do not `setEnabled(false)` or `isVisible = false` — Play uses `performancePriority = Intermediate`, and hidden emitters drop out of the active mesh list so GPU particles never draw. Readiness-gated `start()` and normal draining `stop()` are separate from immediate bundle retirement. Texture and material completion must match the live incarnation, owner scene, generation, and desired playback state. Play close, `changescene`, despawn, and `assignParticle` with a null guid retire the bundle immediately. CPU fallback capacity is `min(capacity, 512)`.

Overlay Play and `apps/player` pass a particle library (Emitter + System payloads) into `createEngine`, same pattern as `audioLibrary` / `textureBytes`. Packed player hydrates `ParticleEmitter` / `ParticleSystem` JSON from the pack. Test-mode `window.__babylonslateParticleStats` (`particleStats`) exposes `systems`, `playing`, `gpu`. Play open/close must return `systems` to 0.

Missing Texture skips that emitter and logs `particle.missing_texture` (asset guid is the Emitter).

Preview uses the same constructors on a Material-Preview-style disposable Scene (app-lifetime Engine, RTT + 2D blit, never a second Engine). Optional particle-domain Material compiles through `MaterialLibrary` then `createEffectForParticles`. Prefab Preview uses that Engine too (`p18-shared-prefab-engine`).

Scripting: **Play Particles** (`particles.play`) / **Stop Particles** (`particles.stop`) — exec + optional `actorRef("Actor")` (unconnected → `ctx.self`). Graphs emit `setParticlePlaying` only.

## Commands

Worker → main. Main thread resolves Emitter / System payloads from the Play particle library.

```ts
| { type: "assignParticle"; slotId: number; actorGuid: string; componentId: string;
    particleSystemGuid: string | null; play?: boolean;
    sortingLayer?: string; orderInLayer?: number }
| { type: "setParticlePlaying"; actorGuid: string; componentId?: string; playing: boolean }
```

`ParticleComponent` properties: `particleSystemGuid`, `playOnStart`, sorting layer/order. Play-on-start emits `assignParticle` with `play: true`. Sorting layer sets `IParticleSystem.renderingGroupId`. Graph Play/Stop target `self` when Actor is unconnected.

## Out of P17

Mesh path, bursts, sub-emitters, noise, attractors, flow maps, ramps, sprite-sheet flipbooks, hemisphere/cylinder/custom emitters, NPE, fluid renderer, particle-age material node, any second renderer.

## Component ownership and playback

A live component has an exact incarnation and a preparation generation. Its desired playback state is recorded before readiness callbacks can run. The states are preparing, ready-stopped, playing, draining, and failed/retired. Texture and material preparation has the existing scene readiness deadline; failure removes custom readiness checks, releases the bundle, and reports an owner-scoped diagnostic.

- Repeated Play while preparing or playing is idempotent: no native reset, repeated acquisition, or new material preparation. Stop while preparing cancels that generation. Late completions cannot start it or a successor with the same actor/component key.
- Normal Stop stops new emission and drains existing particles. CPU completion uses the native live-particle count. GPU completion uses a conservative historical maximum lifetime (including lifetime gradients and pre-stop edits), advanced by native simulation time on actual draws. GPU processed-slot counts are recorded separately and never used as a nonzero live-particle count. Drained native systems and their leases are retired; a later Play prepares one new run. Play during drain explicitly replaces the draining run.
- GPU creation uses the owning engine's transform-feedback/compute capabilities and `emitRateControl: true`. The factory's Babylon 9.20 adapter records the public `animate` clock, including prewarm; draw observations avoid double-counting multiply/add passes. No GPU readback is used in gameplay. Pausing freezes simulation time and therefore drain time.
- Each emitter leases a scene-local, generation-specific MaterialLibrary instance. Mutable particle texture blocks are isolated per emitter. Its texture lease includes the alpha interpretation; texture wrappers are never mutated incompatibly after acquisition.
- Missing SceneLayers keep assignments pending without creating world-scene resources. Owner migration creates a new native bundle. Despawn, SceneLayer loading/removal/clear, world replacement, session reset, scene disposal, and handle disposal invalidate pending callbacks and release the matching resources.

Focused regressions are in `particle-lifecycle.test.ts`, `particle-material-ownership.test.ts`, `particle-service.test.ts`, `particle-system-factory.test.ts`, and `particle-preview.test.ts`. Real browser emission/drain evidence and platform checks are recorded separately; NullEngine lifecycle tests do not prove GPU output.

### Follow-up verification record

The unchanged baseline `5a405051` failed all five initial lifecycle regressions. A stopped delayed upload and a replaced predecessor each called native `start` once after completion; 100 pending and 100 active repeated Play commands called it 201 times; a missing SceneLayer created one world-scene system; and capability selection followed the later NullEngine. The initial queued attempt was cancelled without executing tests, then the same committed fixture ran under the shared resource profile.

At `6ce3a954`, the lifecycle, service, factory, preview, and NodeMaterial particle files passed 44 tests. The ownership file had one passing cancellation case and four failures because its default graph did not sample a texture. At `740f9580`, all five ownership cases passed with an explicit Particle Texture graph; the other five files were unchanged. Together these runs cover 49 cases. The fixed lifecycle fixture records one native start and zero resets for repeated Play, zero late starts after Stop or replacement, zero resources in a missing owner, and no mesh/geometry/observer/lease growth over 200 native lifecycle cycles. Ownership checks retain a second emitter's material and texture after retiring the first, across both creation orders and shared/separate scenes.

The two-case follow-up at `150ee60a` remained queued and was cancelled at the user's request; neither case executed. The machine's shared configuration had returned to a 3 GiB reserve while free physical RAM was 3.45 GiB, below admission for the additional 1.5 GiB test reservation. The owned helper and its verified descendants were stopped; the shared configuration and unrelated processes were left unchanged. The subsequent D integration renames handle cleanup to `dispose` and adds cache/environment failure handling; these changes and the small browser metadata/graph-cycle fixture edits have no new local test result.

Resume these exact scopes with `BL_TEST_PROFILE=shared` when resources allow:

- `pnpm --silent agent:wait local --script test -- packages/render/src/particle-lifecycle.test.ts packages/render/src/create-engine.play.test.ts -t "keeps assignments and restarted runs frozen|retires particle owners on world replacement"`: paused creation/restart and world/SceneLayer command retirement, two cases, unexecuted.
- Scoped `packages/render` and `apps/editor` package `typecheck` scripts through the shared admission runner and foreground `agent:wait`; no workspace typecheck. Both remain unexecuted for F.
- `pnpm --silent agent:wait local --script test:e2e -- e2e/particle-lifecycle.spec.ts`: four WebGL2/WebGPU CPU/GPU cases, unexecuted. The attachment records requested/effective backend, driver, browser, fixed resolution, pixel evidence separately from processed slots, 100 authored-material lifecycle cycles, owned buffer/texture/material counts, and simulation/submission CPU distributions. Software adapters must be labelled from actual driver output; they do not establish hardware performance.

Physical A16 measurements were waived for this delivery. Particle-specific exported-player lifecycle verification remains open. No device timing or GPU output result is inferred from NullEngine tests; the user authorized deferring checks that cannot currently be admitted, not treating them as passed.
