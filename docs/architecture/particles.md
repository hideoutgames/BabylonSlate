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

`ParticleComponent` references a Particle System. `playOnStart`, sorting layer/order. Actor transform is `IParticleSystem.emitter`.

## Authoring

- **New Asset → Rendering**: Particle Emitter (`.emitter.babasset`) and Particle System (`.particles.babasset`).
- DockView **Preview** + **Details** (Sprite-style). Windows toggles those tabs. Preview with no Texture shows **No Texture**. With a Texture guid, Preview runs `GPUParticleSystem` (CPU fallback) on the Material-Preview-style disposable Scene (app-lifetime Engine, RTT + 2D blit, never a second Engine).
- Lucide `Sparkles` (Particle System / ParticleComponent) and `Wind` (Particle Emitter); family color matches Material.
- **Place Actors → Particles** and **Place Actors → Project** Particle System spawn `ParticleComponent`. Engine Particle stays empty until a System is picked.
- Add Component / Search: `ParticleComponent` (`particleSystemGuid`, play-on-start, sorting layer/order).
- Editor viewport uses a camera-facing billboard helper (`billboard:particle`), same as audio/light/camera. Play hides that helper (`meshKind: "particle"`).

Emitter Details: Texture, optional particle-domain Material (AssetPicker filters `domain === "particle"`), capacity 16–4096, emit rate, blend Standard/Additive, shape point/box/sphere/cone, lifetime/speed/size min/max, gravity, color start/end (RGB + alpha), angular speed, pre-warm cycles.

System Details: space world/local, looping, duration, up to 8 Emitter slots (duplicates allowed).

## GPU-safe authored surface

Construct `GPUParticleSystem` when `GPUParticleSystem.IsSupported`; else `ParticleSystem` with `min(capacity, 512)`. Capacity default 256, clamp 16–4096.

Author only the shared CPU/GPU surface: `emitRate`; `createPointEmitter` / `createBoxEmitter` / `createSphereEmitter` / `createConeEmitter`; `minLifeTime` / `maxLifeTime`; `minEmitPower` / `maxEmitPower`; `gravity`; `minSize` / `maxSize` plus single-value `addSizeGradient` / `addColorGradient` (2–8 keys); angular speed or one `addAngularSpeedGradient`; optional `addDragGradient` (0 and 1 keys); `blendMode` Standard / Additive; `isLocal`; looping vs `targetStopDuration`; capped `preWarmCycles`.

GPU `stop()` still draws leftover particles; teardown must `dispose()`. Do not author sub-emitters, bursts (`manualEmitCount`), `disposeOnStop`, dual min/max gradient values, emit-rate / start-size gradients, `textureMask`, or mesh emitters.

Always set `system.particleTexture` from the Emitter Texture guid (ResourceCache). An NME Particle Texture preview is ignored at runtime.

## Particle-domain materials

`createEffectForParticles` requires `NodeMaterialModes.Particle`. Material `domain: "particle"` sits beside `surface` | `postProcess`.

| Node | Kind | Babylon |
| --- | --- | --- |
| Particle Color | `input.particleColor` | `particle_color` attribute (`ParticleColorBlock` in NME; Babylon 9 has no class) |
| Particle Texture | `input.particleTexture` | `ParticleTextureBlock` (live sample is `system.particleTexture`) |

Shared math / Mix / Combine stay legal. Hide world attributes, WPO, PBR metallic, Normal Map, post-process buffers. Terminal is fragment color/alpha only (no `output.surface`). Emitter AssetPicker filters `domain === "particle"`. Missing material = Babylon default `texture * particleColor`. Particle blend is `IParticleSystem.blendMode`, not MeshComponent `blendMode`.

## Runtime

`ParticleService` in `@babylonslate/render` is Audio-shaped: main thread, worker never imports Babylon. Commands: `assignParticle` / `setParticlePlaying`. Each Particle System slot becomes one Babylon `GPUParticleSystem` (or CPU `ParticleSystem`). The Babylon `emitter` is an invisible mesh parented to the actor origin. `start()` / `stop()` / `reset()`; GPU `stop()` still draws leftovers, so teardown must `dispose()` (Play close, `changescene`, despawn, `assignParticle` with a null guid). CPU fallback capacity is `min(capacity, 512)`.

Overlay Play and `apps/player` pass a particle library (Emitter + System payloads) into `createEngine`, same pattern as `audioLibrary` / `textureBytes`. Packed player hydrates `ParticleEmitter` / `ParticleSystem` JSON from the pack. Test-mode `window.__babylonslateParticleStats` (`particleStats`) exposes `systems`, `playing`, `gpu`. Play open/close must return `systems` to 0.

Missing Texture skips that emitter and logs `particle.missing_texture` (asset guid is the Emitter).

Preview uses the same constructors on a Material-Preview-style disposable Scene (app-lifetime Engine, RTT + 2D blit, never a second Engine). Prefab Preview uses that Engine too (`p18-shared-prefab-engine`).

Scripting: **Play Particles** (`particles.play`) / **Stop Particles** (`particles.stop`) — exec + optional `actorRef("Actor")` (unconnected → `ctx.self`). Graphs emit `setParticlePlaying` only.

## Commands

Worker → main. Main thread resolves Emitter / System payloads from the Play particle library.

```ts
| { type: "assignParticle"; slotId: number; actorGuid: string; componentId: string;
    particleSystemGuid: string | null; play?: boolean }
| { type: "setParticlePlaying"; actorGuid: string; componentId?: string; playing: boolean }
```

`ParticleComponent` properties: `particleSystemGuid`, `playOnStart`, sorting layer/order. Play-on-start emits `assignParticle` with `play: true`. Graph Play/Stop target `self` when Actor is unconnected.

## Out of P17

Mesh path, bursts, sub-emitters, noise, attractors, flow maps, ramps, sprite-sheet flipbooks, hemisphere/cylinder/custom emitters, NPE, fluid renderer, particle-age material node, any second renderer.
