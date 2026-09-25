# Particles

Particles wrap Babylon `GPUParticleSystem` / `ParticleSystem` as **billboard quads only**. Plan: [engineplan.md](../engineplan.md) §2.7. Decisions and staging: [particle emitters design note](../design/particle-emitters.md). Live Babylon docs: `/features/featuresDeepDive/particles`.

- **Basic Particle Emitter** (`p-particle-basic`): a module stack with no scripting, applied onto a GPU system with a CPU fallback.
- **Particle System**: up to 8 emitter slots played together on one actor.
- **Particle Graph** (`p-particle-graph`, planned): a node-graph emitter lowered onto Babylon Node Particle blocks. Not in the code yet.

## Why wrap Babylon

`GPUParticleSystem` (WebGPU compute or WebGL2 transform feedback; the A16 iPad default) and `ParticleSystem` (CPU simulation, GPU draw) already render plane particles: shape emitters, gradients, `isLocal`, prewarm, `targetStopDuration`, `blendMode`, `billboardMode`. The look is `NodeMaterial.createEffectForParticles(system)` in **Particle** mode.

- Do **not** write a custom tick or simulator, thin-instance particles, Solid Particle System, points cloud, fluid renderer, mesh particles or `MeshParticleEmitter`.
- Do **not** use the Node Particle Editor UI, snippets, `ParticleHelper` or Babylon JSON payloads. Never store `ParticleSystem.serialize()` as a payload.
- Own schema in `@babylonslate/assets` (Babylon-free), then **apply** onto a live `IParticleSystem` in `@babylonslate/render`.
- Quads only (`isBillboardBased = true`). No second renderer.

## Assets

| Asset | Type, file | Payload | Header dependencies |
| --- | --- | --- | --- |
| Basic Particle Emitter | `ParticleEmitter`, `.emitter.babasset` | `schemaVersion: 2` module stack ([below](#basic-particle-emitter)) | Its Material only |
| Particle System | `ParticleSystem`, `.particles.babasset` | `emitterGuids` (up to 8, ordered, duplicates allowed); `space` (World / Local → `isLocal` on every slot); `previewSkybox` (editor only, missing → true) | Its emitters |

- `ParticleComponent` references a Particle System: `particleSystemGuid`, `playOnStart`, sorting layer/order. The actor transform is the Babylon `emitter`. Sorting layer maps onto `renderingGroupId`; `orderInLayer` is stored and forwarded on `assignParticle` for component parity.
- **No migration.** Header versions stay 1; `schemaVersion` is a payload field, never a top-level `version`. Normalizers read only the nested shape. Old flat P17 fields (`emitRate`, `textureGuid`, `materialGuid`, `sizeGradient`, …) and the System's old `looping` / `duration` are ignored, so old assets load with the defaults below and may change look.
- The registry runs no normalizer at v1, so every read site normalizes: Play and previews (`particleLibraryFromAssets`), the packed player (`hydrate.ts`) and Details.
- `ParticleLibrary` in `@babylonslate/assets` is the one library shape for Play, previews, render and the player: `emitters` (tagged `{ kind: "basic", payload }`; PR3 adds `graph`) and `systems`.
- Shared ids and budgets (blend and billboard ids, capacity 16–4096, CPU budget 512, 8 slots, 2–8 curve keys, `PARTICLE_UPDATE_SPEED`, `particlePrewarmSteps`) live in `@babylonslate/core` `particle-settings.ts`, so the Babylon-free Particle Graph IR can share them.

## Basic Particle Emitter

Schema: `packages/assets/src/particle-basic-emitter.ts`; value specs: `particle-values.ts`; burst schedule: `particle-schedule.ts`. `resolveBasicEmitterPlan(payload, { backend, space })` returns a Babylon-free plan with string ids, which render applies.

### Module stack

Stages render in this order. **Always** modules have no switch. **Toggle** modules store `enabled` and keep their values while off.

| Stage | Module | Kind | Fields | Babylon |
| --- | --- | --- | --- | --- |
| Emitter | Emitter | Always | Material; Capacity 16–4096; Loop (Infinite, Once); Duration 0.05–600 s; Pre Warm 0–10 s | Material effect; capacity (CPU `min(capacity, 512)`); `targetStopDuration` (Once only); `preWarmCycles` / `preWarmStepOffset` |
| Spawn | Spawn Rate | Always | Rate | `emitRate` (a Curve is driven by the service) |
| Spawn | Bursts | Toggle | Up to 8 entries: Time, Count, Cycles, Interval | `manualEmitCount`, scheduled by the service ([Bursts](#bursts)) |
| Shape | Shape | Always | Point, Box, Sphere, Hemisphere, Cylinder, Cone ([Shapes](#shapes)) | `create*Emitter` / `createDirected*Emitter` |
| Initialize | Initialize Particle | Always | Lifetime, Speed, Size, Color | `min/maxLifeTime`; `min/maxEmitPower`; `min/maxSize` or `addSizeGradient`; `addColorGradient` |
| Initialize | Scale | Toggle | Scale X, Scale Y | `min/maxScaleX`, `min/maxScaleY` (off → 1) |
| Initialize | Rotation | Toggle | Start Rotation, Rotation Speed | `min/maxInitialRotation`; `min/maxAngularSpeed` or `addAngularSpeedGradient` (off → 0) |
| Over Life | Speed Over Life | Toggle | Multiplier | `addVelocityGradient` |
| Over Life | Speed Limit | Toggle | Limit; Damping 0–1 | `addLimitVelocityGradient`; `limitVelocityDamping` |
| Over Life | Drag | Toggle | Drag | `addDragGradient` |
| Forces | Gravity | Toggle | Acceleration (m/s², default 0, −9.81, 0) | `gravity` (off → 0) |
| Render | Render | Always | Blend Mode; Billboard | `blendMode`; `billboardMode` ([Look](#look)) |

Defaults give a visible fountain once a Material is picked: Cone (radius 0.1, 30°), Rate 20 /s, Lifetime 0.8–1.2 s, Speed 1–2 m/s, Size 0.2–0.4, Color gradient white → transparent, Additive, Camera Facing, Capacity 256, Infinite 2 s loop, no Pre Warm, every Toggle module off.

### Value modes

A scalar is **Constant** `{value}`, **Random Range** `{min, max}` or **Curve** `{keys}`. A color is Constant, Random Range (two colors) or **Gradient** (stored as `mode: "curve"`). Curves and gradients have 2–8 keys, first at 0 and last at 1, at least 1/256 apart. Colors are RGBA 0–1; brightness above 1 belongs in the Material. `PARTICLE_VALUE_SPECS` / `PARTICLE_COLOR_SPEC` are the one table that the normalizer, the plan and the editor read.

| Property | Modes (default first) | Stored range | Unit shown | Curve runs over |
| --- | --- | --- | --- | --- |
| Rate | Constant, Curve | 0–10000 | /s | Emitter cycle |
| Lifetime | Random Range, Constant, Curve | 0.01–60 | s | Emitter cycle |
| Speed | Random Range, Constant | 0–1000 | m/s | — |
| Size | Random Range, Constant, Curve | 0–100 | — | Particle age |
| Color | Gradient, Constant, Random Range | 0–1 per channel | — | Particle age |
| Scale X, Scale Y | Constant, Random Range | 0–100 | — | — |
| Start Rotation | Random Range, Constant | ±2π rad | deg | — |
| Rotation Speed | Constant, Random Range, Curve | ±50 rad/s | deg/s | Particle age |
| Multiplier (Speed Over Life) | Constant, Curve | 0–100 | — | Particle age |
| Limit (Speed Limit) | Constant, Curve | 0–1000 | m/s | Particle age |
| Drag | Constant, Curve | 0–1 | — | Particle age |

- Rate and Lifetime curves run over the **emitter cycle** (Start → End). The service samples them each frame and writes `emitRate` / `min/maxLifeTime`. `addEmitRateGradient`, `addLifeTimeGradient` and `addStartSizeGradient` are never called, so `start()` never throws on looping emitters.
- Every other curve runs over **particle age** (Birth → Death) as a Babylon gradient. A gradient replaces its fixed counterpart in Babylon, so each property sets one side: a Size curve uses `addSizeGradient`, a Rotation Speed curve `addAngularSpeedGradient`.
- Color is always a color gradient, so `color1` / `color2` / `colorDead` are never authored. Constant is one key; Random Range is one key with `color2` (each particle keeps one color between A and B); Gradient is N keys.
- Speed Over Life, Speed Limit and Drag are always gradients; Constant is one flat key.
- Mode switches keep the look (`convertScalarValueMode` / `convertColorValueMode`): Constant → Range gives `[v, v]`, Range → Constant the midpoint, Range → Curve a min → max ramp, Curve → Range the key extremes, Curve → Constant the first key.
- Invalid values, or a mode the property does not allow, normalize to the property default. Ranges are ordered and clamped.

### Shapes

| Shape | Fields | Babylon |
| --- | --- | --- |
| Point | Direction Min / Max | `createPointEmitter` |
| Box | Box Min / Max (±100); Direction Min / Max | `createBoxEmitter` |
| Sphere | Radius, Radius Range; Direction | `createSphereEmitter` / `createDirectedSphereEmitter` |
| Hemisphere | Radius, Radius Range, Direction Randomizer (no Directed mode) | `createHemisphericEmitter` |
| Cylinder | Radius, Height, Radius Range; Direction | `createCylinderEmitter` / `createDirectedCylinderEmitter` |
| Cone | Radius, Angle (full opening, 1–180°), Radius Range, Height Range, Emit From Spawn Point Only; Direction | `createConeEmitter` / `createDirectedConeEmitter`, then `radiusRange`, `heightRange`, `emitFromSpawnPointOnly` on the instance |

- **Direction** is Radial (Direction Randomizer 0–1) or Directed (Direction Min / Max). Directions are not normalized: their length multiplies Speed.
- Radius is 0.001–100; a zero radius with a zero randomizer would normalize a zero vector on the GPU. Radius Range and Height Range are 0–1 (0 spawns on the surface, 1 fills the volume).
- Changing the shape keeps the fields both shapes share.
- Babylon does not normalize the hemisphere direction on WebGL2 transform feedback, so the plan divides Speed by the radius there to match WebGPU compute and the CPU.

### Bursts

- An entry fires **Count** particles (1–4096) at **Time**, then Cycles − 1 more every **Interval** (0.01–600 s). **Cycles** is 0–64; 0 repeats every Interval until the cycle ends. Fire times at or after Duration never fire.
- The plan caps each burst at the capacity the backend runs (at most 512 on the CPU fallback). The stored Count is not capped, because Capacity commits on every keystroke and a stored cap would lose counts for good.
- Infinite emitters repeat their bursts every loop; Once emitters fire them once. Rate 0 gives a bursts-only emitter.
- Babylon has no burst schedule. The emission driver (`packages/render/src/particle-emission-driver.ts`) counts the particles due in each frame's window of the cycle (`burstParticlesInWindow`) and writes `manualEmitCount` after the frame renders. Bursts therefore fire **one frame late** by design. Bursts are **not simulated during prewarm**: GPU prewarm runs inside the first ready render and would emit a queued burst, so a GPU emitter with Pre Warm advances its driver only after its first draw.
- Babylon leaves `manualEmitCount = 0` after consuming it, which would mute rate emission forever, so the driver restores `-1` on the next frame. A manual frame also skips that frame's rate emission; the driver adds `round(rate × dt)` back only when nothing was pending (count `-1` or `0`).
- `basicEmitterSlotNeed` estimates the live particles an emitter needs (rate × longest lifetime plus the peak burst particles in any lifetime-long window across loop wraps). Details does not show it yet.

## Look

- The look is a **particle-domain Material** (`domain: "particle"`, `NodeMaterialModes.Particle`), bound with `createEffectForParticles`. Emitters have no Texture field: sample textures inside the Material with **Texture Sample**, whose unwired UV (or a **UV** node) reads `particle_uv` in Particle mode. **Particle Color** is the per-particle color from the emitter's Color. See [shader graph](shader-graph.md).
- Babylon's `isReady()` requires a ready `particleTexture`, so each native system owns a 1×1 white `RawTexture` (`slate:particleReadiness`) that no shader samples. The system's default `dispose()` releases it.
- An emitter without a usable Material does not render: the slot is skipped with `particle.missing_material` and the editor shows **No Material**. No default Material or Texture ships.
- Materials that still contain the removed **Particle Texture** node fail validation (`material.unknownNode`), so their emitters are skipped until the node is replaced (for example with Texture Sample).
- Emitters own blending; particle-domain Materials hide their own Blend Mode row.

| Blend Mode | Id | Babylon constant | Result |
| --- | --- | --- | --- |
| Additive (default) | `additive` | `BLENDMODE_ONEONE` | src + dst |
| Alpha Blend | `standard` | `BLENDMODE_STANDARD` | src·α + dst·(1−α) |
| Alpha Additive | `add` | `BLENDMODE_ADD` | src·α + dst |
| Multiply | `multiply` | `BLENDMODE_MULTIPLY` | dst·src |
| Subtract | `subtract` | `BLENDMODE_SUBTRACT` | dst − src |

| Billboard | Id | Babylon constant | Notes |
| --- | --- | --- | --- |
| Camera Facing (default) | `all` | `BILLBOARDMODE_ALL` | |
| Y Axis | `y` | `BILLBOARDMODE_Y` | |
| Stretched | `stretched` | `BILLBOARDMODE_STRETCHED` | The quad's Y axis follows velocity; Scale Y lengthens it. Babylon's GPU shader does not scale the length with speed. |

- `packages/render/src/particle-render-modes.ts` is the only numeric mapping and reads Babylon's constants by name. Documents store only the ids.
- `createEffectForParticles` compiles only the ONEONE and MULTIPLY effects. Alpha Blend, Alpha Additive and Subtract reuse the ONEONE effect (the only blend-dependent define is `BLENDMULTIPLYMODE`) under their own engine alpha state.
- Outside the Material editor preview, particle Materials insert Babylon's `ParticleBlendMultiplyBlock` before the fragment output (color → `color`, alpha → `alphaTexture`, constant 1 → `alphaColor`). Under Multiply a transparent texel then leaves the destination unchanged; other modes pass through.

## Units

- `updateSpeed = PARTICLE_UPDATE_SPEED` (1/60), set at creation. Rate is per second; Lifetime, Duration, Time and Interval are seconds; Speed and Limit are m/s; gravity is m/s²; angles are stored in radians (shown in degrees) and angular speed in rad/s. Babylon's default of 0.01 made one unit about 1.67 s.
- Pause sets `updateSpeed = 0` and restores each system's value. The emission driver and the GPU drain clock run on simulation time, so they pause too. Systems that become ready while paused (a Restart, a rebuild or a new assignment) start on resume, because prewarm at `updateSpeed` 0 simulates nothing and never runs again.
- **Pre Warm** applies to Infinite emitters only; on a Once emitter Babylon advances the stop clock during prewarm, so the row is disabled. `particlePrewarmSteps(s)` gives `preWarmCycles = min(60, ceil(s × 30))` and `preWarmStepOffset = s × 60 / cycles`. Steps are 1/30 s up to 2 s and grow beyond it (10 s gives 1/6 s steps), so gravity, drag and damping integrate coarsely and particles shorter-lived than a step are born and die within it. CPU prewarm runs inside `start()`; GPU prewarm runs on the first render.
- **Speed Limit** multiplies the velocity by Damping on every update step while speed exceeds the limit, so its effect depends on frame rate.
- **Drag** scales each step's displacement by (1 − Drag). It never decays the velocity, so it acts as a speed multiplier; Drag 1 freezes the particle.

## Authoring

- **New Asset → Rendering**: **Basic Particle Emitter** (`.emitter.babasset`; searching "basic" finds it) and **Particle System** (`.particles.babasset`). Document tabs still read "Particle Emitter". Icons: Lucide `Wind` (emitter) and `Sparkles` (Particle System, `ParticleComponent`), in the `--asset-material` family.
- Both documents open DockView **Preview** (primary) and **Details** (right, 360px); Windows toggles both.
- **Emitter Details** is a `ModuleStack`. Each stage has a sticky header with its [stage accent](theming.md#particle-stage-roles); each module card has a chevron, title, collapsed summary (`20 /s`, `No Material`, `Additive · Camera Facing`) and an enable switch on Toggle modules. Disabled modules collapse and keep their data. Card open state is kept per document for the session.
- Value rows put a `ValueModeField` beside the label (Constant / Random Range / Curve / Gradient). Random Range rows show Min and Max. Curves and gradients expand inline (`CurveField` / `GradientField`) with draggable keys, Add Key / Add Stop and numeric Time / Value or Location / Color fields. Units render verbatim in parentheses after the label, never humanized: `Duration (s)`, `Rate (/s)`, `Speed (m/s)`, `Start Rotation (deg)`, `Rotation Speed (deg/s)`, `Acceleration (m/s²)`.
- Continuous edits use the undo merge key `particle-field:<payload path>`, so one scrub or drag is one undo entry. Mode switches, toggles, list edits, shape changes and picks are separate entries.
- The Material row and the Preview's **Pick Material** open a picker limited to particle-domain Materials.
- **System Details**: Space, Preview Skybox and an `EntryListEditor` of emitter slots. Add is disabled at 8 slots, duplicates are allowed and the picker has no None row; a slot is removed with its trash action. A slot whose asset is gone reads **Missing Emitter**.
- **Place Actors → Particles** and Project Particle System tiles spawn an actor with `ParticleComponent`; the Engine Particle stays empty until a System is picked. The editor viewport shows the camera-facing `billboard:particle` helper; Play hides it (`meshKind: "particle"`).

### Preview

- Emitter Preview wraps the emitter in a synthetic one-slot System. System Preview loads each slot's emitter from its open tab first, else from its document; registry headers carry no emitter payload.
- `ParticlePreviewCanvas` runs a `ParticleService` (`statsScope: "local"`) on a disposable preview Scene on the app-lifetime Engine (RTT + 2D blit, never a second Engine). Emitter Preview has no skybox; System Preview shows the engine default skybox when Preview Skybox is on. Textures come from the Materials' Texture Sample nodes.
- Controls (`ParticlePreviewSurface`): **Restart** re-issues `assignParticle`; **Play / Pause** calls `setPaused`; a **GPU / CPU / GPU + CPU** badge (the CPU tooltip notes the 512 cap); an active-count badge polled every 250 ms (`~n / capacity` on GPU, where the count is the claimed ring).
- States: **Loading Preview** (first boot only), **No Material** (with Pick Material), **No Emitters**, **Missing Emitter**, **Preview Failed** with **Retry**. A skipped slot while other slots play shows as a notice. A finished Once emitter releases its systems but stays ready, so Restart replays it. Error states keep the canvas mounted.
- Edits go through `ParticleService.updateLibrary`, which applies the change tier below. The preview asks the service first (`libraryChangeTier`): `live` (or `none`) edits apply at once unless a heavier edit is already waiting; `respawn` and `rebuild` wait for a 220 ms trailing debounce and show **Updating**. Only the service knows skipped slots, so a value edit on a skipped slot, which re-prepares the whole bundle, also waits.
- A different set of Material guids, a skybox change or Retry starts a new preview Scene, because the Material resolver knows only the Material documents collected at boot. The last frame stays up with Updating. Edits inside a Material document reach the preview only after one of those.

| Tier | Edits | Effect |
| --- | --- | --- |
| `live` | Constant and Range values; Rate and Lifetime curves; bursts; Infinite Duration; gravity and damping; shape values within the same shape and direction mode; blend outside Multiply; gradient keys with unchanged counts | Applied in place; GPU gradient textures rebake; particles survive |
| `respawn` | Shape kind, direction mode or Emit From Spawn Point Only; gradient key counts; blend into or out of Multiply | GPU particles restart (`reset()`); emission continues |
| `rebuild` | Capacity, Loop, Pre Warm, Once Duration, Material, Billboard; a gradient appearing, disappearing or gaining `color2` | The emitter is recreated |

CPU particles already alive pick up gradient edits at their next key; new particles use them at once.

### Test ids

- Stack `particle-emitter-modules`. Module cards `module-card-<id>` (`-toggle`, `-enabled`, `-summary`, `-body`) for `emitter`, `spawnRate`, `bursts`, `shape`, `initialize`, `scale`, `rotation`, `speedOverLife`, `speedLimit`, `drag`, `gravity`, `render`.
- Rows `property-<rowId>`: `material`, `capacity`, `loop`, `duration`, `prewarm`, `rate`, `lifetime`, `speed`, `size`, `color` (`color-min` / `color-max` in Random Range), `scaleX`, `scaleY`, `startRotation`, `rotationSpeed`, `speedMultiplier`, `speedLimit`, `damping`, `drag`, `gravity`, `blendMode`, `billboard`. Shape rows: `shape`, `radius`, `radiusRange`, `height`, `angle`, `heightRange`, `emitFromSpawnPointOnly`, `direction`, `directionRandomizer`, `direction1`, `direction2`, `boxMin`, `boxMax`. Range rows add `-min` / `-max`; value-mode buttons are `value-mode-<rowId>`.
- Bursts: list `particle-emitter-bursts` (Add `particle-emitter-bursts-add`), rows `property-burst-<i>-{time,count,cycles,interval}`.
- Pickers: `particle-emitter-material-picker` (Details), `particle-preview-material-picker` (Preview), `particle-system-emitter-picker`. System slots `particle-system-emitter-<i>` in list `particle-system-emitters` (Add `particle-system-emitters-add`).
- Preview: `particle-emitter-preview-canvas`, `particle-system-preview-canvas`; `particle-preview-controls`, `-restart`, `-play` (`aria-pressed`), `-backend`, `-count`, `-updating`, `-notice`, `-empty`, `-loading`, `-failed`, `-action`.

## Runtime

`ParticleService` in `@babylonslate/render` is the main-thread owner shared by overlay Play, the packed player and previews. The worker never imports Babylon, and graphs emit commands only.

- Each Particle System slot becomes one native system. Its `emitter` is an **enabled** zero-visibility box parented to the actor origin (`isVisible = true`, `visibility = 0`, `alwaysSelectAsActiveMesh`, not pickable). Do not `setEnabled(false)` or set `isVisible = false`: Play uses `performancePriority = Intermediate`, and hidden emitters drop out of the active mesh list, so GPU particles never draw.
- **Backend per emitter:** `GPUParticleSystem` with `emitRateControl: true` when the owning engine supports compute (WebGPU) or transform feedback (WebGL2); otherwise CPU `ParticleSystem` with `min(capacity, 512)`. The owning engine decides, not the last-created one.
- **GPU slot ring:** under `emitRateControl`, Babylon sizes the ring from rate × lifetime and overwrites live particles when bursts overlap. The owned GPU system claims the whole ring (`capacity`) after construction and after `reset()`; never-emitted slots have zero size and draw nothing. A runtime check on the Babylon internals fails the slot with `particle.apply_failed` after an incompatible upgrade. At capacity the GPU recycles the **oldest** particle, while the CPU **drops new** ones.
- **Apply:** `applyBasicEmitterPlan(system, plan, "create" | "live" | "respawn")` writes the plan before the Material binds, because GPU render defines depend on the gradient textures. `live` and `respawn` never write `updateSpeed`, prewarm or `targetStopDuration`. `bindParticleMaterial` waits for the NodeMaterial build, then calls `createEffectForParticles`.
- **Emission driver:** one per slot, advanced after each rendered frame while playing, on simulation time (a GPU emitter with Pre Warm starts after its first draw). It samples the Rate and Lifetime curves over the cycle and queues [bursts](#bursts).
- **Loop and drain:** Once emitters set `targetStopDuration = Duration`, stop natively and drain on their own; Infinite emitters wrap the driver's cycle clock. When every slot has stopped, the System drains. Stop halts each driver before muting it (`manualEmitCount = 0`, then `stop()`). CPU slots finish at zero live particles. GPU slots wait the full lifetime bound, because a claimed ring always reports full capacity.
- **Failures skip one slot:** a missing emitter, a missing or unusable Material, a native apply throw or a rejected Material build skips and disposes only that slot, and the other slots play. Only the readiness timeout, a throw outside one slot, or having no playable slot fails the whole entry (no native systems, `systems` 0).
- `setLibrary` (Play) replaces the library for later preparations. `updateLibrary` (previews) applies change tiers to prepared bundles and re-prepares bundles whose slots were skipped or failed; `libraryChangeTier(library)` returns that tier without applying it. Draining and released bundles pick changes up on their next Play. `playbackState(actorGuid, componentId)` returns the component's state, `null` without an entry; a released bundle reads `ready-stopped`, not `failed`.
- **Stats:** `stats()` returns `systems`, `playing`, `gpu` and `gpuSystems`. A `"global"` service (Play and the player; the default) publishes them to test-mode `window.__babylonslateParticleStats` (`particleStats`); previews use `"local"`. Play open/close must return `systems` to 0. `previewStats()` returns `{ active, capacity, backend: "gpu" | "cpu" | "mixed" | "none", approximate }`; GPU `active` is the claimed ring.
- Overlay Play and `apps/player` pass the `ParticleLibrary` into `createEngine`, like `audioLibrary`. The packed player hydrates `ParticleEmitter` / `ParticleSystem` JSON with `particleLibraryFromAssets`. Emitters load no textures; the Material's textures load with the Material.
- Scripting: **Play Particles** (`particles.play`) / **Stop Particles** (`particles.stop`), exec plus optional `actorRef("Actor")` (unconnected → `ctx.self`). Graphs emit `setParticlePlaying` only.

| Diagnostic | Cause | `assetGuid` | Effect |
| --- | --- | --- | --- |
| `particle.unknown_system` | `assignParticle` names a System that is not in the library | System | Playback skipped |
| `particle.unknown_emitter` | A slot's emitter is not in the library | Emitter | Slot skipped |
| `particle.missing_material` | No Material ("has no Material"), or the Material is missing, invalid or not Particle domain ("has no usable Material") | Emitter | Slot skipped |
| `particle.apply_failed` | Native apply throw or a rejected Material build | Emitter | Slot skipped and disposed |
| `particle.apply_failed` | Readiness timeout or a throw outside one slot | System | Entry fails |

## Commands

Worker → main. The main thread resolves Emitter / System payloads from the Play particle library.

```ts
| { type: "assignParticle"; slotId: number; actorGuid: string; componentId: string;
    particleSystemGuid: string | null; play?: boolean;
    sortingLayer?: string; orderInLayer?: number }
| { type: "setParticlePlaying"; actorGuid: string; componentId?: string; playing: boolean }
```

`ParticleComponent` properties: `particleSystemGuid`, `playOnStart`, sorting layer/order. Play-on-start emits `assignParticle` with `play: true`. Sorting layer sets `IParticleSystem.renderingGroupId`. Graph Play/Stop target `self` when Actor is unconnected.

## Component ownership and playback

A live component has an exact incarnation and a preparation generation. Its desired playback state is recorded before readiness callbacks can run. The states are preparing, ready-stopped, playing, draining, and failed/retired. Material preparation has the existing scene readiness deadline; failure removes custom readiness checks, releases the bundle, and reports an owner-scoped diagnostic. Play close, `changescene`, despawn, and `assignParticle` with a null guid retire the bundle immediately.

- Repeated Play while preparing or playing is idempotent: no native reset, repeated acquisition, or new material preparation. Stop while preparing cancels that generation. Late completions cannot start it or a successor with the same actor/component key.
- Normal Stop stops new emission and drains existing particles. CPU completion uses the native live-particle count. GPU completion uses a conservative historical maximum lifetime (including lifetime curves and pre-stop edits), advanced by native simulation time on actual draws. GPU processed-slot counts are recorded separately and never used as a nonzero live-particle count. Drained native systems and their leases are retired; a later Play prepares one new run. Play during drain explicitly replaces the draining run.
- GPU creation uses the owning engine's transform-feedback/compute capabilities and `emitRateControl: true`. The factory's Babylon 9.20 adapter records the public `animate` clock, including prewarm; draw observations avoid double-counting multiply/add passes. No GPU readback is used in gameplay. Pausing freezes simulation time and therefore drain time.
- Each emitter leases a scene-local, generation-specific MaterialLibrary instance (`acquireParticleMaterial`); a Material outside the Particle domain is released and refused. Each native system owns its readiness texture; there are no particle texture leases.
- Missing SceneLayers keep assignments pending without creating world-scene resources. Owner migration creates a new native bundle. Despawn, SceneLayer loading/removal/clear, world replacement, session reset, scene disposal, and handle disposal invalidate pending callbacks and release the matching resources.

## Babylon 9.20 adapter notes

Particle NodeMaterial define changes retire the replaced DrawWrapper after the current frame; Babylon delays effect disposal but destroys its WebGPU draw context immediately. The adapter also releases queued wrappers on engine disposal. Browser proofs count playback resets separately from CPU disposal resets.

The pinned Babylon patch carries the NodeMaterial shader language through particle effect recreation. Without it, a WGSL particle material can request a GLSL replacement after live defines change and never become ready again. This is separate from the adapter's observer and draw-wrapper ownership.

The custom-material adapter registers the native GPU WGSL vertex shader and sets the GPU draw wrapper's instancing flag. Babylon's default effect initialization performs both operations, but the pinned custom-effect path bypasses them; a cold first emitter must prepare without relying on an earlier default-material emitter.

That version boundary also prepares native update/gradient resources before creating the custom render effect. Gradient-backed streams differ from per-particle color streams; selecting their defines during the first draw is too late for that draw's captured wrapper. The browser fixture checks validation messages as well as visible pixels.

## Tests

- Assets: `particle-values.test.ts`, `particle-schedule.test.ts`, `particle-basic-emitter.test.ts`, `particle-library.test.ts`, `particle-payload.test.ts`.
- Render: `particle-system-factory.test.ts` (blend mapping against Babylon-imported constants, billboard ids through Babylon's billboard shader paths, seconds, shapes, readiness texture), `particle-emission-driver.test.ts`, `particle-service.test.ts`, `particle-lifecycle.test.ts`, `particle-material-ownership.test.ts`, `particle-preview.test.ts`, `node-material-particles.test.ts`, `material-compiler.test.ts` (a particle Texture Sample reads `particle_uv`), `create-engine.play.test.ts`.
- Shader graph: `validate.test.ts` (an old Particle Texture node reports `material.unknownNode`).
- Editor: `particle-emitter-panels.test.tsx`, `particle-system-panels.test.tsx`, `particle-preview-recovery.test.tsx`, `particle-value-modes.test.ts`, `play-particles.test.ts`. Player: `hydrate.test.ts`. Exporter: `closure.test.ts` (Component → System → Emitter → Material → Texture).
- NullEngine tests do not prove GPU output. The readiness texture never reports ready on NullEngine, so CPU behaviour tests step `animate` directly.
- The browser lifecycle proof (`apps/editor/src/testing/particle-lifecycle-proof.ts`, `e2e/particle-lifecycle.spec.ts`; WebGL2/WebGPU × CPU/GPU in CI) draws red and blue emitters through two Particle Color × tint Materials, balances Material lease acquisitions and releases, runs 100 lifecycle cycles, and captures blend cases over mid-grey and overlapping bursts that need the ring claim. `e2e/p17-particles.spec.ts` covers authoring through Play ([testing](testing.md)).
- The P17 follow-up cases recorded as unexecuted in [renderer qualification](../design/renderer-qualification.md) row F were not run. This slice rewrote those fixtures and does not convert that status into a pass.

## Out of scope

- Both kinds: sprite-sheet flipbooks, noise, flow maps, sub-emitters and triggers, mesh and custom emitters, `textureMask`, ramp and remap gradients, the NPE UI, snippets and Babylon JSON payloads, `ParticleHelper`, SPS, fluid renderer, a particle-age material node, any second renderer.
- Basic only: attractors (the planned Particle Graph has an Attractor node).
- Deferred: the Particle Graph (`p-particle-graph`), a GPU tier for declarative graphs, script-settable graph parameters, live particles in the edit-mode viewport.
