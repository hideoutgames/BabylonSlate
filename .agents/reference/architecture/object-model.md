# Object Model

Headless runtime object graph: World, Actors, components, subsystems, tick order, class registry, guids and snapshots.

## Ownership

- [`packages/object-model/src/`](../../../packages/object-model/src/) (`@haptic/object-model`) depends only on `@haptic/core`. Never import React, Babylon or Capacitor here.
- Runtime systems that drive it: [`packages/runtime/src/`](../../../packages/runtime/src/) (driver, script host, `PhysicsWorldSync` in `physics-sync.ts`, `world-component-index.ts`, `actor-world-transform.ts`).
- Component placement (`world` / `overlay` / `any`) is declared once in `ENGINE_COMPONENT_DESCRIPTORS` ([`packages/core/src/engine-components.ts`](../../../packages/core/src/engine-components.ts)); SceneLayer allow/deny lists and object-model ids derive from it.
- Deterministic harness: `runDeterministicScenario` in [`packages/test-kit/src/harness.ts`](../../../packages/test-kit/src/harness.ts) (seed, fixed dt, N ticks, canonical snapshot golden).

## Types

| Type | Contract |
| --- | --- |
| `BObject` | guid, classId, variables, `onCreation` / `onTick` / `onDestroyed`. `variablesRevision` advances only on a real change. |
| `Actor` | Transform plus ordered components. Writing `parentId` / `name` through `variables` bumps `World.structuralRevision`. |
| `ActorComponent` | Own variables and interfaces; Begin Play after owner spawn. `attachComponent` throws on a destroyed actor. |
| `Scene` | Live Play scene, `classId` `Scene:{assetGuid}`; `sceneName`, `assetGuid` (Get-only), `gravity` (Get/Set). Not spawnable. |
| `SceneLayer` / `SceneLayerActor` | Overlay session instance (not an Actor) / overlay actor tagged `sceneLayerId`, same World tick. |
| `GameInstance` | Session singleton. |
| `Subsystem` → `GameSubsystem`, `SceneSubsystem` | Hidden abstract base (never in pickers) → session-lifetime / main-Scene-lifetime singletons. ClassKind stays `object`. |
| `World` | Owns GI, subsystems, actors in spawn order, seeded RNG, deferred destroy, `currentScene`. |
| `ClassRegistry` | Inheritance graph. `MAX_CLASS_INHERITANCE_DEPTH` = 16 (including self). Locked engine ids (`isLockedEngineClassId`) cannot be reparented. |

## Invariants

- Simulation code never calls `Math.random`; use the World RNG (`createSeededRng`, core).
- Never iterate a `Map` for tick or snapshot order. Spawn/attach use arrays; subsystem lists sort with `compareClassIds` (code-unit order, never locale).
- Mid-tick spawn/destroy enqueue and flush after the current phase, so a destroy never skips a sibling. `tick()` is not re-entrant. An ended World never ticks (`tick()` returns -1), refuses `createScene` and cancels queued spawns.
- Code that edits `actor.components` in place must call `World.markStructureChanged()`: `componentOwners` (component-class owner lists) is cached on `structuralRevision`.
- `createActor` / `createComponent` / subsystem creation deep-copy class variable defaults (`hydrateClassVariableValue`); no two instances share an object value.
- Play binds a per-frame `onTick` only where a script can run (scripted actor lineages, project component classes); engine component classes never get one.

## Tick phases (`TICK_PHASES`, fixed order)

1. `gameInstance`: GameInstance `onTick`, then live GameSubsystems in class-id order.
2. `sceneSubsystems`: main Scene's SceneSubsystems; gated by `canTickScene` then `canTickSceneSubsystem`.
3. `actors` (spawn order) → 4. `components` (attach order) → 5. `physics` (backend `step` + write-back, filled by `@haptic/physics`) → 6. `postPhysics` (boundary only).

`WorldOptions.canTickScene` suspends phases 2–6 during cooperative scene preparation while the Game Instance keeps ticking; `canTickActor` gates individual owners and SceneLayers. Both are rechecked mid-tick.

## Subsystems

- No registration list: every **leaf** user class of a subsystem lineage is instantiated automatically (`instantiableSubsystemClassIds`). Overlay Play, Preview Build and exports all do this.
- Fixed guids, never from `guidFactory` (so actor guids do not shift): `subsystem:<classId>`, `scene-subsystem:<classId>:<n>` (`n` counts main-Scene creations).
- `ended` flips when End starts (Get, ticks, notifications skip it); `destroyed` when End returns. Init runs at most once and never after End.
- Order: `start()` runs GameSubsystems On Init, then Game Instance On Init. `setGameSubsystems` throws after `start()`. `end()` exits the scene, then GI On End, then GameSubsystems On End in reverse.
- Every main `createScene` (including same-scene reload) builds fresh SceneSubsystems before its actors spawn; streamed sub-scenes and SceneLayers never create them. `clearCurrentScene` is the single exit path: SceneSubsystems On End (reverse) → Scene `onDestroyed` → On Scene Exit.
- Scene Actor Spawned fires immediately before `onCreation` (world actors only); Destroyed/Removed reach exactly the subsystems that heard Spawned/Added. Hooks from `WorldOptions.sceneSubsystemHooksFor` run synchronously; deferring hosts must preserve order.
- `findSubsystems(classId)`: GameSubsystems, then current SceneSubsystems, each in class-id order; first entry is the Get result.

## Guids and identity

- Two live actors never share a guid. `spawnActor` throws `DuplicateActorGuidError` (queued destroys still hold their guid). Documents repeating an actor id are rejected at load (`normalizeScene`, `normalizeSceneLayer`, realization), never repaired.
- Replacement commits the predecessor's destruction first (Change Scene, Save Game restore).
- Instanced ids are scoped: streamed actors `scene-stream:${JSON.stringify([instance, id])}`, SceneLayer actors `<layerGuid>:<id>`; scripted spawns get fresh guids.
- Cleanup that may race a successor reusing a guid works by object identity: `destroyActorInstance`, render slots (owned by actor objects), physics body incarnations, inspector tokens, stale load cleanup.
- `World.findActor` uses an incremental guid index; queued spawns stay invisible and queued destroys visible until commit.

## Actor hierarchy

- `parentId` names the parent guid; parents resolve through the live guid index. Child world matrix = `local × parentWorld` (Babylon parenting; math in [`packages/core/src/affine-transform.ts`](../../../packages/core/src/affine-transform.ts)).
- Shear from nonuniform parent scale with an oblique child: exact translation, per-axis world length scale, nearest proper rotation (polar decomposition), one `actor` warning per actor. Physics still rejects shear.
- Parent cycles in loaded data are broken at load: the link closing the cycle (last-spawned member's) is cleared with a warning; streamed actors re-root under their streaming actor.

## Snapshots

- `createWorldSnapshot`: canonical JSON golden for the harness, sorted variable keys. **Not** the bridge binary layout ([bridge](bridge.md)). `subsystems` is omitted when empty so subsystem-free goldens stay byte-identical.
- `createDebugInspectSnapshot`: lossy, JSON-safe Play inspector tree; every actor appears once even with parent cycles.

## Script surface

- `ENGINE_CLASS_SCRIPT_APIS` ([`engine-script-api.ts`](../../../packages/object-model/src/engine-script-api.ts)) is the Get/Set/Call/Add Event catalog: `variables`, `functions`, component-bound `events`, and Self lifecycle `nativeEvents` (which never feed `engineEventTypeClassIds`).
- Overlay pointer events live only on `2DButtonComponent`; collision events on `ColliderComponent`. Animation Graph, Behaviour Tree, NavMesh, NavMesh Blocker and Blocking Volume are ref-only.
- `dispatchInterface` returns pin defaults (fresh deep copy) when no handler exists, never `undefined`.
- `ClassRegistry.reparent` rejects cycles, locked ids and depth overflow, and returns invalidated inherited members. `ensure` merges metadata but never rewrites `parentClassId`. `loadScripts` registers parents before children.

## Product decisions

- No `ModelComponent`: imported models bind on `MeshComponent.assetGuid`.
- **Prefab** (`.prefab.hasset`, kind `prefab`) is logic-free `{ components }` (`SerializedPrefab`). Placed instances are plain `Actor`s with baked components and `prefabGuid`; the runtime ignores `prefabGuid` and never loads the Prefab, and Spawn Actor cannot spawn one.
- `DeformerComponent` is visual-only: physics, navigation and CPU picking keep the original shape. The worker sends revisioned `setActorDeformers` control snapshots, never vertices. Limits in [`deformer-component.ts`](../../../packages/core/src/deformer-component.ts) (`DEFORMER_MAX_CONTROLS` 64, coordinates clamp to ±1e10 before Float32 upload). Unavailable in SceneLayers.
