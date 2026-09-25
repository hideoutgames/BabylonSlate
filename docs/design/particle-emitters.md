# Particle emitters

Decision record for the **Particle emitters** named slice (`p-particle-*`). It redesigns P17 particles into two emitter kinds that share one Particle System, one Material-based look and one visual language. The reference for shipped behaviour stays [architecture/particles.md](../architecture/particles.md); this note records decisions, rationale and staging. Plan: [engineplan.md](../engineplan.md) §2.7 and Appendix A.

## Status

| PR | Checklist | Scope | Status |
| --- | --- | --- | --- |
| 1 | `p-particle-design` | This note, engineplan §2.7 revision, tracker section. Docs only | Landed with this note |
| 2 | `p-particle-basic` | Basic Particle Emitter module stack, Material-only look, seconds, Babylon-constant blend/billboard mapping, bursts, new editor kit components | Planned |
| 3 | `p-particle-graph` | Particle Graph IR, lowering onto Babylon Node Particle blocks, graph editor, mixed-kind Particle System | Planned |

Until PR2 lands, the code is the P17 surface described in particles.md (Texture field, Standard/Additive, `BILLBOARDMODE_ALL`).

## Decisions

| # | Decision | Why |
| --- | --- | --- |
| D1 | Two emitter kinds. **Basic Particle Emitter** is a module stack with no scripting, applied onto `GPUParticleSystem`. **Particle Graph** is our own node-graph IR lowered onto Babylon 9.20 Node Particle blocks. | A Niagara-style stack covers most effects on the GPU; a Babylon-style graph covers custom per-particle logic. |
| D2 | GPU/CPU is chosen **per emitter**. Basic is GPU (`emitRateControl: true`), with the existing CPU fallback (`min(capacity, 512)`) only when the owning engine lacks transform feedback and compute. Particle Graph is CPU. A Particle System mixes both kinds in its slots. | Babylon's only system constructor under `Particles/Node` is `new ParticleSystem(...)` (`Particles/Node/Blocks/Emitters/createParticleBlock.pure.js:89`), and the GPU update shader (`gpuUpdateParticles`) is a fixed effect with no hook for custom code. Mixing per slot is Niagara's own model and needs no parity between backends. |
| D3 | Graph documents never store a backend. | A GPU tier for declarative graphs can be added later without a format change. |
| D4 | The look is a **Material**. Both kinds require a particle-domain Material; emitters have no Texture field. Textures are sampled inside the Material with **Texture Sample** + **UV** (UV reads `particle_uv` in Particle mode). The **Particle Texture** material node is removed; **Particle Color** stays. | One look path. Babylon still requires a ready `particleTexture` (`isReady` in `thinParticleSystem.pure.js` and `gpuParticleSystem.pure.js`), so each native system owns a 1×1 white readiness texture that no shader samples. |
| D5 | No emitter without a Material renders. The editor shows **No Material**; the runtime skips the slot with `particle.missing_material` (`assetGuid` = the emitter; covers an unset, missing or non-particle Material). No default Material or Texture ships. | The user supplies materials; generated artwork is not allowed ([no-ai-artwork](../../.agents/rules/no-ai-artwork.md)). |
| D6 | **Seconds** for both kinds: `updateSpeed = 1/60`. Rate is per second, lifetime and duration are seconds, gravity is m/s², angular speed is rad/s (angles are stored in radians and shown in degrees). | Babylon's defaults differ (classic 0.01, `SystemBlock` 0.0167), so today 1 unit ≈ 1.67 s. |
| D7 | Blend and billboard options map to Babylon constants **by name** (`ParticleSystem.BLENDMODE_*`, `BILLBOARDMODE_*`), never repo-local numbers. | The P17 constants are swapped (`BLENDMODE_ONEONE` is 0 and `STANDARD` is 1 in Babylon), so saved "Additive" renders alpha-blended today. |
| D8 | **No migration.** The project is unreleased. Header versions stay 1; normalizers read only the new shape and fill defaults, so existing emitters load with new defaults and may change look. | A chain step would force a save-approval prompt for a format nobody shipped. |
| D9 | Lifecycle belongs to the **emitter**: Loop, Duration and Pre Warm live on each emitter of either kind. The Particle System keeps its slots, **Space** and **Preview Skybox**. | Emitter previews show their own timeline, and one System can hold a one-shot flash next to looping smoke. |
| D10 | Quads only (`isBillboardBased = true`). No second renderer, mesh particles, SPS, fluid renderer or custom simulator. The NPE editor UI, snippet server, CDN URLs, `ParticleHelper` and Babylon JSON payloads are never used. | Same split as materials: own schema, then apply or lower in `@babylonslate/render`. |

## Kinds and the Particle System

| Asset | Type | Kind | Suffix | New Asset label | Simulation | Capacity |
| --- | --- | --- | --- | --- | --- | --- |
| Basic Particle Emitter | `ParticleEmitter` | `particle-emitter` | `.emitter.babasset` | Basic Particle Emitter | GPU; CPU fallback | 16–4096 (CPU fallback caps at 512) |
| Particle Graph | `ParticleGraph` | `particle-graph` | `.particlegraph.babasset` | Particle Graph | CPU | 16–4096, warning above 512 |
| Particle System | `ParticleSystem` | `particle-system` | `.particles.babasset` | Particle System | per slot | — |

- A Particle System holds up to 8 ordered slots, duplicates allowed, each a Basic emitter or a Particle Graph.
- `ParticleComponent`, `assignParticle` and `setParticlePlaying` are unchanged: a component still references a Particle System.
- The document tab label for Basic stays "Particle Emitter"; only the New Asset row reads "Basic Particle Emitter".

## Look

**Blend modes** (Render module, graph Emitter Output settings):

| Label | Id | Babylon constant | Blending |
| --- | --- | --- | --- |
| Additive (default) | `additive` | `BLENDMODE_ONEONE` (0) | src + dst |
| Alpha Blend | `standard` | `BLENDMODE_STANDARD` (1) | src·α + dst·(1−α) |
| Alpha Additive | `add` | `BLENDMODE_ADD` (2) | src·α + dst |
| Multiply | `multiply` | `BLENDMODE_MULTIPLY` (3) | dst·src |
| Subtract | `subtract` | `BLENDMODE_SUBTRACT` (−1) | dst·(1−src) |

- `NodeMaterial.createEffectForParticles` compiles only the ONEONE and MULTIPLY effects. Other modes reuse the ONEONE effect (identical defines apart from `BLENDMULTIPLYMODE`) under the correct engine alpha state.
- Particle Materials insert Babylon's `ParticleBlendMultiplyBlock` before the fragment output, so a transparent texel leaves the destination unchanged under Multiply.
- Emitters own blend. The Material's own Blend Mode row is hidden in the particle domain.

**Billboards:** Camera Facing (`BILLBOARDMODE_ALL`, default), Y Axis (`BILLBOARDMODE_Y`), Stretched (`BILLBOARDMODE_STRETCHED`, aligned to velocity; Scale Y lengthens it).

## Basic Particle Emitter

### Value modes

- Scalar properties use one union: **Constant** `{value}`, **Random Range** `{min, max}` or **Curve** `{keys}` (2–8 keys, first at 0 and last at 1, keys at least 1/256 apart). Colors use Constant, Random Range (two colors) or **Gradient** (2–8 stops, RGBA 0–1).
- Each property allows a fixed subset of modes, a range and a unit from one spec table in `@babylonslate/assets` that the editor also reads.
- Curves run over **particle age** (Birth → Death), except the Spawn Rate and Lifetime curves, which run over the **emitter cycle** (Start → End). The service drives emitter-time curves each frame, so Babylon's `addEmitRateGradient` / `addLifeTimeGradient` / `addStartSizeGradient` are never used and `start()` never throws on looping emitters.
- A gradient replaces its fixed counterpart in Babylon (size, color, angular speed), so each property sets exactly one side.
- Switching modes keeps the look: Constant → Range gives `[v, v]`; Range → Constant gives the midpoint; Curve → Range spans the key extremes.

### Module stack

Stages render in this order. **Always** modules have no switch; **Toggle** modules keep their values while disabled.

| Stage | Module | Kind | Fields (modes) | Babylon |
| --- | --- | --- | --- | --- |
| Emitter | Emitter | Always | Material; Capacity; Loop (Infinite, Once); Duration (s); Pre Warm (s, Infinite only) | Material effect; capacity; `targetStopDuration` (Once only); `preWarmCycles` × `preWarmStepOffset` |
| Spawn | Spawn Rate | Always | Rate /s (Constant, Curve over cycle) | `emitRate` |
| Spawn | Bursts | Toggle (off) | Up to 8 entries: Time (s), Count, Cycles, Interval (s) | `manualEmitCount`, scheduled by the service |
| Shape | Shape | Always | Point, Box, Sphere, Hemisphere, Cylinder, Cone; radius, radius range, height, angle, height range, spawn point only; Direction Radial (randomizer) or Directed (Direction Min/Max) | `create*Emitter` / `createDirected*Emitter` and instance fields |
| Initialize | Initialize Particle | Always | Lifetime s (C, R, Curve over cycle); Speed /s (C, R); Size (C, R, Curve); Color (C, R, Gradient) | `min/maxLifeTime`; `min/maxEmitPower`; `min/maxSize` or `addSizeGradient`; `addColorGradient` |
| Initialize | Scale | Toggle (off) | Scale X, Scale Y (C, R) | `min/maxScaleX`, `min/maxScaleY` |
| Initialize | Rotation | Toggle (off) | Start Rotation deg (C, R); Rotation Speed deg/s (C, R, Curve) | `min/maxInitialRotation`; `min/maxAngularSpeed` or `addAngularSpeedGradient` |
| Over Life | Speed Over Life | Toggle (off) | Multiplier (C, Curve) | `addVelocityGradient` |
| Over Life | Speed Limit | Toggle (off) | Limit /s (C, Curve); Damping 0–1 | `addLimitVelocityGradient`, `limitVelocityDamping` |
| Over Life | Drag | Toggle (off) | Drag 0–1 (C, Curve) | `addDragGradient` |
| Forces | Gravity | Toggle (off) | Acceleration m/s² (default 0, −9.81, 0) | `gravity` |
| Render | Render | Always | Blend Mode; Billboard | `blendMode`; `billboardMode` |

Defaults give a visible fountain once a Material is picked: Cone shape, 20 /s, Lifetime 0.8–1.2 s, Speed 1–2, Size 0.2–0.4, Color gradient white → transparent, Additive, Camera Facing, capacity 256.

### Runtime rules

- **Bursts:** Babylon has no burst schedule. The service's emission driver sets `manualEmitCount` after a frame renders and restores rate emission (`-1`) once Babylon has consumed the count (it leaves `0`, which would otherwise mute rate emission forever). Bursts are one frame late by design, so GPU prewarm does not consume them. They are not simulated during prewarm.
- **GPU slot ring:** under `emitRateControl`, Babylon sizes the GPU ring from rate × lifetime and overwrites live particles when bursts overlap. The owned GPU system claims the full ring (`capacity`) at construction and after `reset()`, guarded by a runtime layout check that fails the slot with `particle.apply_failed` after a Babylon upgrade. On GPU the oldest particle is recycled at capacity; on CPU new particles are dropped.
- **Loop and drain:** Once emitters set `targetStopDuration = duration` and drain individually; Infinite emitters wrap the service's cycle clock. A System drains when every slot has stopped. Pre Warm applies to Infinite emitters only; on Once it would consume Duration.
- **Live edits in Preview:** value edits are designed to apply in place and keep particles (to be proven in the browser lifecycle proof; on CPU, live particles pick up an edited curve at their next key). Edits that change GPU update defines or gradient key counts restart GPU particles (Babylon releases its buffers). Capacity, Loop, Pre Warm, Material, Billboard and adding or removing a curve rebuild the emitter.
- Hemisphere direction is not normalized on the WebGL2 transform-feedback backend, so the plan divides Speed by the radius there. This matches compute and CPU only for surface spawns (Radius Range 0) with a small Direction Randomizer; interior particles stay slower on WebGL2.

## Particle Graph

### Package and document

- `@babylonslate/particle-graph` is Babylon-free and React-free, like `@babylonslate/shader-graph`, and depends only on `@babylonslate/core`. `render` lowers its plan onto Node Particle blocks.
- The document holds `schemaVersion`, `name`, `materialGuid`, document-level `settings` (Capacity, Loop, Duration, Pre Warm, Blend Mode, Billboard) and `nodes` / `edges` in the Material graph shape. Positions never enter the compile key, so dragging a node never rebuilds the preview.
- Exactly one protected **Emitter Output** terminal (`particle.output`, Babylon `SystemBlock`) with inputs Particle and Emit Rate (/s). Its texture input is never exposed.
- The default graph is Create Particle → Sphere Shape → Apply Velocity → Update Color (Gradient over Normalized Age) → Emitter Output.

### Catalog (v1)

| Palette category | Nodes (Babylon block) |
| --- | --- |
| Emitter | Create Particle (`CreateParticleBlock`); Emitter Output (`SystemBlock`) |
| Shape | Point, Box, Sphere (Hemispheric option), Cone, Cylinder Shape (`*ShapeBlock`). Sphere, Cone and Cylinder emit radially unless both directions are set |
| Update | Update Position, Direction, Color, Size, Scale, Angle; Apply Velocity (`BasicPositionUpdateBlock`); Fade To Dead Color (`BasicColorUpdateBlock`); Align Angle |
| Forces | Gravity (Babylon's own Direction + acceleration × Delta recipe); Attractor (`UpdateAttractorBlock`) |
| Particle Attributes | Position, Direction, Scaled Direction, Age, Lifetime, Normalized Age, Particle Color, Initial Color, Dead Color, Size, Scale, Angle (contextual `ParticleInputBlock`s) |
| System Values | Time, Delta Time, Emitter Position, Camera Position (system-source `ParticleInputBlock`s; Time and Delta Time in seconds, positions in world space) |
| Constants and Utility | Float, Vector 2, Vector 3, Color; Random (Per Particle: one roll per particle evaluation, fixed in Create Particle inputs but re-rolled every frame in Update inputs; or Every Read); Gradient (2–8 stops edited in Details, lowered to `ParticleGradientBlock` + value blocks) |
| Math | Add, Subtract, Multiply, Divide, Minimum, Maximum, Modulo, Power, Lerp, Smooth Step, Step, Clamp, and the 21 unary operations (`ParticleTrigonometryBlock`) |
| Vector and Logic | Length, Dot Product, Distance, Split, Combine (`ParticleConverterBlock`), Condition |

- **Types:** Float, Vector 2, Vector 3, Color (RGBA) and Particle. Float splats into vectors and colors (Babylon's `adapt` rule); other width changes use Split and Combine.
- **Excluded in v1**, reserved ids that report `particle.unsupportedNode`: sub-emitters and triggers (`ParticleTriggerBlock`, `onStart`/`onEnd`), Mesh and Custom Shape, sprite-sheet blocks, Noise, Flow Map, Update Age, Local Variable, NLerp, Float To Int, debug and teleport blocks, and `SystemBlock` `customShader` / `textureMask` / `translationPivot`.

### Validation (`particle.*`)

- Errors block lowering: `unknownNode`, `unsupportedNode`, `unknownPin`, `danglingEdge`, `duplicateConnection`, `cycle`, `typeMismatch`, `genericConflict`, `missingInput`, `noOutput`, `multipleOutputs`, `spineFanOut` (a Particle output may feed one input; a second branch never reaches Emitter Output, so Babylon never builds it), `perParticleInEmitRate` (Emit Rate is evaluated without a particle context, so particle reads return null and the emitter may never spawn).
- Warnings: `cpuBudget` (capacity above 512), `missingMaterial`, `materialDomain`, `attractorParticleInput`, `shapeDirectionPair`, `multipleShapes`, `noMotion` (nothing moves without a position update), `unreachable`.
- Render adds node-anchored `particle.compile.*` diagnostics for Babylon's string throws.

### Lowering and runtime

- Each prepared slot builds **its own** `NodeParticleSystemSet` and fresh blocks, synchronously inside `ParticleService.prepare` (`SystemBlock.createSystem` + `emitErrors`); `buildAsync` is not used. Every created block is attached to the set, and retiring the slot disposes the set.
- A small `SystemBlock` subclass seeds Babylon's uninitialised `_buildId`, so shared value nodes build once instead of once per consumer (proven by the PR3 build-count test).
- Capacity, `updateSpeed = 1/60`, blend, billboard, Loop/Duration (`targetStopDuration.value`), Pre Warm and Space (`isLocal`) are written before the build; the actor emitter and sorting are applied after it, never through `ParticleSystemSet.emitterNode` (its dispose would destroy the actor mesh). When Space is Local, render lowers Apply Velocity through Babylon's `LocalPositionUpdated` source; Position and Emitter Position reads stay world-space.
- A failed build disposes its partial system and reports a node-anchored diagnostic; the other slots still play (PR3 cleanup test).

## Runtime (`ParticleService`)

- Main-thread service in `@babylonslate/render`; the worker never imports Babylon and graphs emit commands only.
- Slot records carry their kind and their own GPU flag. The P17 lifecycle contracts stay: incarnation, generation, idempotent Play, draining Stop, no GPU readback, SceneLayer ownership, stats returning to 0 on close.
- One `ParticleLibrary` type in `@babylonslate/assets` (tagged `basic` / `graph` emitters plus systems) replaces the three copies in render, the editor and the player.
- Diagnostics: `particle.unknown_system`, `particle.unknown_emitter`, `particle.missing_material` (replaces `particle.missing_texture`), `particle.apply_failed`, plus the graph codes above.

## Editor and visual language

### Documents

| Kind | DockView windows |
| --- | --- |
| Basic Particle Emitter | Preview (primary), Details (right, 360) |
| Particle Graph | Graph (primary), Preview (left, 360), Details (below Preview), Compiler Results (below Graph) — the Material layout |
| Particle System | Preview (primary), Details (right, 360) |

### Shared stage colours

The Basic stage accents and the Particle Graph node headers use one role map onto the existing `--node-*` tokens, so each stage has the same colour in both editors (Basic runs Shape before Initialize; the graph spine runs Create before Shape).

| Stage | Basic stages | Graph nodes | Token |
| --- | --- | --- | --- |
| Output | Emitter, Spawn, Render | Emitter Output | `--node-event` |
| Create | Initialize | Create Particle | `--node-function` |
| Shape | Shape | Shape nodes | `--node-latent` |
| Update | Over Life, Forces | Update and Force nodes | `--node-pure` |
| Input | — | Particle Attributes, System Values, Constants | `--node-variable` |
| Value | — | Math, Vector, Logic, Random, Gradient | `--node-flow` |

### Particle Graph canvas

- **Particle spine:** Particle pins use a new `--pin-particle` token and draw 5px wires (the exec width), so Create → Shape → Update → Emitter Output reads as one heavy line. Pins stay circles: diamonds mean exec, and exec inputs fan in while Babylon particle inputs take one link. Particle pins sit in the first pin row so the spine runs straight.
- Value wires keep their pin colours at 4px. Color pins use `--pin-color`.
- Compiler Results keep `pinId`, so pin error rings show on the canvas.

### Basic Details

- A **module stack**: sticky stage headers with a small accent pill; module cards with a chevron, title, collapsed summary (for example `30 /s`) and an enable switch for toggle modules. Disabled modules collapse, dim and keep their data.
- The value-mode control is a 24px ghost icon button beside the label (44px on coarse pointers) that opens a Title Case menu: Constant, Random Range, Curve or Gradient.
- Curves and gradients show an inline preview in a 28px row and expand inline into an editor with draggable keys or stops, Add/Remove buttons and numeric Time/Value (or Location/Color) fields. Coarse-pointer hit boxes are 44px tall and never overlap.
- Units render verbatim after the label (`s`, `/s`, `deg`, `m/s²`), never through the label humanizer.
- Every scrub uses a stable per-field undo merge key, so one gesture is one undo entry.

### Preview

- One preview surface for all three documents: Restart, Play/Pause, a GPU / CPU / GPU + CPU badge and an active-count badge (exact for CPU slots; GPU slots show their claimed capacity), polled at 4 Hz.
- Empty and failure states: **No Material** (with Pick Material), **No Emitters**, **Missing Emitter**, **Graph Has Errors**, **Loading Preview** (first boot only), **Preview Failed** with Retry.
- Edits apply to the running preview after a 220ms debounce instead of rebuilding the scene.

### New kit components (PR2)

`ModuleStack` / `ModuleStage` / `ModuleCard`, `ValueModeField`, `CurveField`, `GradientField`; `PropertyGrid` gains `unit`, `labelAccessory` and the `range`, `curve`, `gradient` and `color4` row kinds; `ColorField` gains optional alpha. Each gets a [component catalog](../architecture/components.md) row and a Component Gallery entry.

### Labels and icons

- Title Case everywhere ([display names](../../.agents/rules/display-names.md)). The graph terminal is "Emitter Output", never "System".
- Icons: Wind (Basic), Network (Particle Graph), Sparkles (Particle System), all in the `--asset-material` family.

## Out of scope

- Both kinds: sprite-sheet flipbooks, noise, flow maps, sub-emitters and triggers, mesh and custom emitters, `textureMask`, ramp and remap gradients, the NPE UI, snippets and Babylon JSON payloads, `ParticleHelper`, SPS, fluid renderer, a particle-age material node, any second renderer.
- Basic only: attractors (they need scene references; the graph has an Attractor node).
- Deferred: a GPU tier for declarative graphs, script-settable graph parameters, live particles in the edit-mode viewport.

## Rejected alternatives

| Alternative | Why not |
| --- | --- |
| Store `NodeParticleSystemSet.serialize()` | A second graph language with Babylon-owned JSON, non-stable block ids and silently skipped unknown classes |
| Auto-tier a graph between GPU and CPU | The GPU-eligible subset is Basic with wires, and both backends would need a permanent parity suite (they differ in random rolls and gradient sampling) |
| Custom GPU graph compiler | Forks Babylon's GPU particle platforms across WGSL and GLSL before the first particle draws |
| A Texture field on emitters | Two look paths |
| A migration chain | A save-approval prompt for an unreleased format |

## Risks

| Risk | Mitigation |
| --- | --- |
| CPU Particle Graphs on the A16 iPad (per-particle JS closures) | Curated catalog without noise, flow maps or sub-emitters; `cpuBudget` warning above 512; backend-free documents so a GPU tier can follow. Device cost is unmeasured. |
| The GPU ring claim relies on a Babylon internal; that never-emitted slots draw nothing on real drivers, and the iPad cost of full-capacity rings, are read from source only | Runtime layout guard; the browser lifecycle proof covers overlapping bursts and unused slots after any upgrade |
| `particle_color` on GPU with a NodeMaterial, Standard/Add/Subtract on the ONEONE effect, and Multiply leaving the destination unchanged under a transparent texel are read from source only | The rewritten lifecycle proof draws red/blue Particle Color materials and blend cases on WebGL2/WebGPU × CPU/GPU in CI |
| Node Particle blocks under the production bundle, and NodeMaterial binding on graph-built CPU systems (including WebGPU), are backed by a NullEngine probe and code reading only | Blocks are constructed directly (no `Parse` / class registry); the PR3 browser cases prove both |
| Local-space graph lowering is unproven | PR3 test moves the emitter after spawn and checks particles follow |
| Old particle Materials that still contain Particle Texture fail validation (`material.unknownNode`) and render nothing until edited | Documented; no migration by decision D8 |
| Editing a gradient restarts GPU preview particles | Change tiers keep value edits live; restarts are documented |
