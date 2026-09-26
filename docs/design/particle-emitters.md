# Particle emitters

Decision record for the **Particle emitters** named slice (`p-particle-*`). It redesigns P17 particles into two emitter kinds that share one Particle System, one Material-based look and one visual language. The reference for shipped behaviour stays [architecture/particles.md](../architecture/particles.md); this note records decisions, rationale and staging. Plan: [engineplan.md](../engineplan.md) §2.7 and Appendix A.

## Status

| PR | Checklist | Scope | Status |
| --- | --- | --- | --- |
| 1 | `p-particle-design` | This note, engineplan §2.7 revision, tracker section. Docs only | Landed with this note |
| 2 | `p-particle-basic` | Basic Particle Emitter module stack, Material-only look, seconds, Babylon-constant blend/billboard mapping, bursts, new editor kit components | Landed; reference in [particles.md](../architecture/particles.md) |
| 3 | `p-particle-graph` | Particle Graph IR, lowering onto Babylon Node Particle blocks, graph editor, mixed-kind Particle System | Landed; reference in [particles.md → Particle Graph](../architecture/particles.md#particle-graph) |

Both emitter kinds, the Material-only look and the shared Particle System are shipped. [particles.md](../architecture/particles.md) is the reference for their behaviour, so this note keeps only decisions and rationale.

## Decisions

| # | Decision | Why |
| --- | --- | --- |
| D1 | Two emitter kinds. **Basic Particle Emitter** is a module stack with no scripting, applied onto `GPUParticleSystem`. **Particle Graph** is our own node-graph IR lowered onto Babylon 9.20 Node Particle blocks. | A Niagara-style stack covers most effects on the GPU; a Babylon-style graph covers custom per-particle logic. |
| D2 | GPU/CPU is chosen **per emitter**. Basic is GPU (`emitRateControl: true`), with the existing CPU fallback (`min(capacity, 512)`) only when the owning engine lacks transform feedback and compute. Particle Graph is CPU. A Particle System mixes both kinds in its slots. | Babylon's only system constructor under `Particles/Node` is `new ParticleSystem(...)` (`Particles/Node/Blocks/Emitters/createParticleBlock.pure.js:89`), and the GPU update shader (`gpuUpdateParticles`) is a fixed effect with no hook for custom code. Mixing per slot is Niagara's own model and needs no parity between backends. |
| D3 | Graph documents never store a backend. | A GPU tier for declarative graphs can be added later without a format change. |
| D4 | The look is a **Material**. Both kinds require a particle-domain Material; emitters have no Texture field. Textures are sampled inside the Material with **Texture Sample** + **UV** (UV reads `particle_uv` in Particle mode). The **Particle Texture** material node is removed; **Particle Color** stays. | One look path. Babylon still requires a ready `particleTexture` (`isReady` in `thinParticleSystem.pure.js` and `gpuParticleSystem.pure.js`), so each native system owns a 1×1 white readiness texture that no shader samples. |
| D5 | No emitter without a Material renders. The editor shows **No Material**; the runtime skips the slot with `particle.missing_material` (`assetGuid` = the emitter; covers an unset, missing or non-particle Material). No default Material or Texture ships. | The user supplies materials; generated artwork is not allowed ([no-ai-artwork](../../.agents/rules/no-ai-artwork.md)). |
| D6 | **Seconds** for both kinds: `updateSpeed = 1/60`. Rate is per second, lifetime and duration are seconds, gravity is m/s², angular speed is rad/s (angles are stored in radians; Basic Details shows degrees, Particle Graph Details radians). | Babylon's defaults differ (classic 0.01, `SystemBlock` 0.0167), so in P17 1 unit ≈ 1.67 s. |
| D7 | Blend and billboard options map to Babylon constants **by name** (`ParticleSystem.BLENDMODE_*`, `BILLBOARDMODE_*`), never repo-local numbers. | The P17 constants were swapped (`BLENDMODE_ONEONE` is 0 and `STANDARD` is 1 in Babylon), so saved "Additive" rendered alpha-blended. |
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

Blend Mode and Billboard ids, their Babylon constants, the ONEONE/MULTIPLY effect reuse and the `ParticleBlendMultiplyBlock` insertion are in [particles.md → Look](../architecture/particles.md#look). Decisions:

- Emitters own blend (Render module; graph Emitter Output settings). The Material's own Blend Mode row is hidden in the particle domain.
- Blend options are Additive (default), Normal, Alpha Additive, Multiply and Subtract; billboards are Camera Facing (default), Y Axis and Stretched. Both are read from Babylon by name (D7).

## Basic Particle Emitter

The module stack, value modes, shapes, bursts, units and change tiers are in [particles.md → Basic Particle Emitter](../architecture/particles.md#basic-particle-emitter). Decisions behind them:

- One value-mode union per property (Constant, Random Range, Curve; colors use Gradient), with allowed modes, ranges and units in one spec table in `@babylonslate/assets` that the editor also reads. Mode switches keep the look.
- Spawn Rate and Lifetime curves run over the emitter cycle and are driven by the service each frame, because Babylon's emitter-time gradients throw on looping systems. Every other curve runs over particle age as a Babylon gradient.
- Bursts are scheduled by the service through `manualEmitCount`, one frame late and not during prewarm, because Babylon has no burst schedule.
- The owned GPU system claims its whole slot ring so overlapping bursts do not overwrite live particles; a layout guard fails the slot after an incompatible Babylon upgrade.
- Pre Warm applies to Infinite emitters only, because Babylon advances a Once emitter's stop clock during prewarm.
- Preview edits are tiered (`live`, `respawn`, `rebuild`) so value edits keep their particles.

## Particle Graph

The package, document, catalog, validation codes, lowering, Local Space rules and editor are in [particles.md → Particle Graph](../architecture/particles.md#particle-graph). Decisions behind them:

- **Own IR.** `@babylonslate/particle-graph` is Babylon-free and React-free like `@babylonslate/shader-graph`, and depends only on `@babylonslate/core`. `render` lowers its plan onto Node Particle blocks. Storing Babylon's own serialization was rejected (below).
- **Settings live on the document.** Capacity, Loop, Duration, Pre Warm, Blend Mode and Billboard are document settings, not nodes. Space stays on the Particle System (D9), and the document stores no backend (D3).
- **One protected terminal.** Exactly one **Emitter Output** (`particle.output`, never "System") with Particle and Emit Rate inputs. `SystemBlock` texture, stop duration, triggers, pivot and texture mask are never pins.
- **Position-free compile key.** Positions, the name and the Material never enter the compile key. Dragging a node never rebuilds the preview, and a Material change only rebinds.
- **Curated catalog.** Every node carries a `role` for its header colour, with no id-prefix parsing. Babylon names that read poorly are retitled (Apply Velocity, Fade To Dead Color) and kept as search aliases. Excluded features keep reserved ids that report `particle.unsupportedNode`, so a later version can enable them without renaming.
- **Types.** Float, Vector 2, Vector 3, Color and Particle, with no Int. Babylon's own Float splat is the only implicit conversion.
- **Linear spine.** A Particle output feeds one input (`spineFanOut`), because a second branch never reaches Emitter Output and Babylon never builds it.
- **Emit Rate has no particle.** A per-particle read (or a system position) in Emit Rate is an error, not a warning, because the emitter may never spawn or the build fails.
- **Direct, synchronous build.** Blocks are constructed with `new`, never through `Parse`, snippets or `buildAsync`. Each prepared slot builds synchronously into its own `NodeParticleSystemSet`. A failed build disposes only that slot and reports a node-anchored `particle.compile.*` diagnostic, and the other slots still play.
- **Build once.** A `SystemBlock` subclass seeds Babylon 9.20's uninitialised `_buildId`, so shared value nodes build once instead of once per consumer (proven by a build-count test).
- **Settings before the build.** Settings, including the actor's emitter mesh, are written on the `SystemBlock` before the build; only sorting follows it. Nothing goes through `ParticleSystemSet.emitterNode`, whose dispose would destroy the actor's mesh.
- **Local Space.** Apply Velocity lowers through `LocalPositionUpdated`, because node-built systems skip Babylon's own local step. Position, Emitter Position and Attractor reads stay world-space; this is documented rather than converted.
- **No capacity cap.** Graph capacity is 16–4096 with a `cpuBudget` warning above 512. A stored 512 cap would encode the backend (D3).

## Runtime (`ParticleService`)

- Main-thread service in `@babylonslate/render`; the worker never imports Babylon and graphs emit commands only.
- Slot records carry their kind and their own GPU flag. The P17 lifecycle contracts stay: incarnation, generation, idempotent Play, draining Stop, no GPU readback, SceneLayer ownership, stats returning to 0 on close.
- One `ParticleLibrary` type in `@babylonslate/assets` replaced the three copies in render, the editor and the player. It holds `basic` and `graph` emitter entries.
- A failure skips only its slot. Graph edits rebuild only their own slot, or just rebind a changed Material. Shipped behaviour and diagnostics: [particles.md → Runtime](../architecture/particles.md#runtime).

## Editor and visual language

### Documents

| Kind | DockView windows |
| --- | --- |
| Basic Particle Emitter | Preview (primary), Details (right, 360) |
| Particle Graph | Graph (primary), Preview (left, 360), Details (below Preview), Compiler Results (below Graph) — the Material layout |
| Particle System | Preview (primary), Details (right, 360) |

### Shared stage colours

The Basic stage accents and the Particle Graph node headers use one role map onto the existing `--node-*` tokens, so each stage has the same colour in both editors (Basic runs Shape before Initialize; the graph spine runs Create before Shape). Table: [theming → Particle stage roles](../architecture/theming.md#particle-stage-roles).

### Particle Graph canvas

- **Particle spine:** Particle pins use a new `--pin-particle` token and draw 5px wires (the exec width), so Create → Shape → Update → Emitter Output reads as one heavy line. Pins stay circles: diamonds mean exec, and exec inputs fan in while Babylon particle inputs take one link. Particle pins sit in the first pin row so the spine runs straight.
- Value wires keep their pin colours at 4px. Color pins use `--pin-color`.
- Compiler Results keep `pinId`, so pin error rings show on the canvas.
- The shipped canvas, Details and Preview are in [particles.md → Graph editor](../architecture/particles.md#graph-editor).

### Basic Details and Preview

- Basic Details is a module stack with compact value-mode controls, inline curves and gradients, verbatim units and one undo entry per gesture. The shipped layout, preview states, change tiers and test ids are in [particles.md → Authoring](../architecture/particles.md#authoring).
- One preview surface serves all three documents. While a Particle Graph has errors, previews keep its last valid build rather than blanking; a graph that never validated shows **Graph Has Errors**.
- PR2 added `ModuleStack` / `ModuleStage` / `ModuleCard`, `ValueModeField`, `CurveField` and `GradientField`, extended `PropertyGrid` and `ColorField`, and added the `ParticlePreviewSurface` app wrapper; see the [component catalog](../architecture/components.md).

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
| Node Particle blocks under the production bundle, and NodeMaterial binding on graph-built CPU systems (including WebGPU), are backed by NullEngine tests and code reading until CI runs the browser proof | Blocks are constructed directly (no `Parse` / class registry); the lifecycle proof's mixed Basic + Graph cases cover both on WebGL2 and WebGPU in CI |
| Local-space graph lowering | The realize test moves the emitter after spawn: Local particles follow it, World particles do not. Radial shape directions still use the world emitter position (documented) |
| Old particle Materials that still contain Particle Texture fail validation (`material.unknownNode`) and render nothing until edited | Documented; no migration by decision D8 |
| Editing a gradient restarts GPU preview particles | Change tiers keep value edits live; restarts are documented |
