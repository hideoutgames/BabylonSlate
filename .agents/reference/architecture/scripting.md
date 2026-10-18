# Scripting

Contributor reference for Haptic's visual scripting: Class graph IR, pin types, validation, JavaScript code generation, runtime binding in `ScriptHost`, and the editor graph surfaces.

## Packages and boundaries

| Package | Owns | Must not import |
| --- | --- | --- |
| [`packages/scripting/`](../../../packages/scripting/src/) | Graph IR (`ir.ts`), pin types (`types.ts`), wildcard resolution, type context, validator + rule hook, deterministic codegen + anchor tables (`compile.ts`), engine enums/structs (`engine-types.ts`), Tags, Data catalog | React, Babylon, Capacitor, `scripting-nodes` |
| [`packages/scripting-nodes/`](../../../packages/scripting-nodes/src/) | Data-driven node catalog, one module per category; `createDefaultNodeRegistry()` | React, Babylon, Capacitor |
| [`packages/graph-ui/`](../../../packages/graph-ui/src/) | Touch React Flow shell reused by Class, Material, Particle, Animation and Behaviour Tree graphs | Babylon, Capacitor, `scripting-nodes` |
| [`packages/core/`](../../../packages/core/src/) | `formatValue`, keyed `print-hud`, `editor-only.ts` host helpers | React, Babylon, Capacitor |
| [`packages/runtime/`](../../../packages/runtime/src/) | `ScriptHost` (`script-host.ts`), `loadCompiledModule` (`module-loader.ts`), `RuntimeDriver` | Babylon, DOM |
| [`packages/object-model/`](../../../packages/object-model/src/) | `ENGINE_CLASS_SCRIPT_APIS` / `engineScriptApiFor` / `engineNativeEventsFor` (`engine-script-api.ts`), `TICK_PHASES` | React, Babylon, Capacitor |
| [`apps/editor/`](../../../apps/editor/src/) | Class document panels, Compiler Results, `GraphScriptCompileCache` ([`services/script-compiler.ts`](../../../apps/editor/src/services/script-compiler.ts)), `collectPlayPreviewScripts` ([`services/play-content-service.ts`](../../../apps/editor/src/services/play-content-service.ts)) | Capacitor |

- The compiler takes a **node registry injected at compile time**; `scripting` never depends on `scripting-nodes`. `scripting` may import only `instrumentJsLoops` from `@babylonslate/debugger`.
- Node codegen emits `ctx.*` calls only. Navigation (Recast), physics and rendering live behind `ScriptHostServices`; nodes never import them.
- `graph-ui` stays catalog-free: hosts hydrate pins (`__pins`, `__category`, `__pure`, `__latent`, `__editorOnly`) before handing graphs to it. Keep graph-kind specifics injectable; do not hardcode scripting assumptions into the canvas.

## Formats

- Class assets are `.class.babasset`; parents include `BObject`, `Actor`, `ActorComponent`, `GameInstance`, `GameSubsystem`, `SceneSubsystem`, `FunctionLibrary`, `EditorFunctionLibrary`, `BDebugCommand`, `EditorUtilityObject` and the `BT*` bases. The hidden `Subsystem` base is never offered.
- IR: `LogicGraph { id, kind: "event" | "function", nodes, edges }`; nodes carry `typeId` (catalog id), typed `pins` and `properties`; edges name both pin ends. `SerializedGraph` adds `members` (variables, locals with `functionId`, functions with `pins[]`, interfaces, custom events), `functionGraphs[id]` and Actor prefab `components`.
- Schema changes bump the Class asset version. Older versions are refused with `AssetFormatVersionError`; there is no migration.
- Literal pin defaults are stored as `default:<pinId>` keyed by **pin id**, never display name. Lookup order: wire → `default:<pinId>` → catalog `GraphPin.defaultValue` → type default. Instance pins (`objectRef` / `actorRef`) take no literal (`pin.invalid_default`; compiles to `null`). Because the lookup always yields a value, `pin.missing_input` never fires for literal pins; it covers instance pins (error), Class/Asset pins with no authored or catalog default, other non-literal kinds, `reference: "required"` pins and interface-implementation Output pins (error).
- Map variable defaults persist as `{ key, value }[]` JSON and hydrate to `Map` (later duplicates win). Arrays persist as `unknown[]`.
- Tags: project `settings.tags` `{ tags: [{ id, path, parentId }], nextId }`; IDs are stable u32 (0 = None), never reallocated from display order; discarded IDs still advance `nextId`.
- Asset/Class-typed declarations carry **Loading**: absent = Soft (referenced, never loaded with the owner); `"hard"` joins the owner's required closure (Class header `requiredVariableNames`). Synchronous readers (`input.*`, `data.readEntry`) still require their values. Dependency metadata is stamped on save.
- Data Definitions (`.datadefinition.babasset`) and Data Trees (`.datatree.babasset`) address entries by exact, case-sensitive name paths; internal IDs are never lookup fallbacks.

## Pin types

- Kinds (`types.ts`): `exec`, `bool`, `int`, `float`, `string`, `tag`, `vec2/3/4`, `rotator`, `quat`, `transform`, `color`, `objectRef`, `actorRef`, `classRef`, `assetRef`, `structRef`, `enumRef`, `array`, `map`, `delegate`, `resolvingWildcard`, `boxedWildcard`. Math kinds are first-class, not fake Structures.
- Assignability: `int` → `float` only; subclass refs → superclass pins of the same kind; any instance ref → `objectRef("BObject")`; narrowing needs Cast; `classRef` is a class value, never an instance; `structRef`/`enumRef` need an exact guid (empty guid assigns nowhere); anything → `boxedWildcard`, never implicit unbox.
- Two wildcards, never conflated: **resolving** (compile-time generic for container nodes; one group `T` per node unless `group` set; inputs are hard constraints, wider compatible types win) and **boxed** (raw runtime value for Print and user wildcard params).
- `resolveWildcardPinTypes` ([`wildcard-resolve.ts`](../../../packages/scripting/src/wildcard-resolve.ts)) is a view: stored `__pins` stay `resolvingWildcard`. Compilation applies the resolved view to a temporary graph; canvas connection checks use resolved display types.
- Values are not boxed on the wire. `WildcardTo*` uses the source's compile-time tag when typed, otherwise infers from the runtime value; enums, classes and assets are strings at runtime.
- Engine enums/structs (`engine:CollisionChannel`, `engine:HitResult`, `engine:TagContainer`, …) live in `ENGINE_ENUMS` / `ENGINE_STRUCTS`, not the Content Browser.

## Validation

- Pure `(graphs, TypeContext, rules) → Diagnostic[]`; packages add rules with `registerValidationRule`. Diagnostics anchor to `assetGuid`, `graphId`, `nodeId`, `pinId` (plus `bodyLine` for ExecuteJavaScript). Behaviour Trees use `validateBehaviourTree`.
- Validator and compiler share the TypeContext builder: a graph that validates compiles.
- Node-scoped diagnostics run only on nodes the compiler would emit (`compiledNodeIds`); isolated nodes and exec islands without a trigger never block Play.
- `event.duplicate` (error) names a second entry of a singleton event in one graph: same `typeId` + `componentId`, same custom event name, or same Input Action/Axis for `input.*` events (all of which share the `onTick` handler, so the handler name is never the identity). A wired Input Binding or an unbound input event cannot be compared and is skipped. `event.name_collision` stays for differently spelled custom names that compile to one identifier.
- `pin.unexecuted_source` (warning) anchors on a compiled node's data input wired from an impure node (one with exec pins) that is not in `compiledNodeIds`: unwired impure nodes do not run, so their output slots keep type defaults. `relatedNodeId` is the source.
- Diagnostic messages name pins and events by display label (`humanizePropertyLabel` / `formatEventTitle`, both in `core`), never by pin id.
- Runs on edit (250 ms debounce, open graph), save (document + dependents), pre-Play (whole project closure), export (adds export-only rules) and CI golden fixtures (`packages/scripting/fixtures/`, one broken graph per code).
- Warnings never block. Errors block Play through a dialog with **Play Anyway** per run; there is no persistent bypass. Demote noisy rules rather than hardening the dialog.
- Parent cycles are refused at write time (Attach Actor, Attach To Bone, `parentId` sets) with a warning; loaded data breaks cycles at load.

## Compiler and codegen invariants

- IR → plain JavaScript ES modules (no TypeScript in the browser). Output is deterministic text; golden tests are the primary gate. Compiled output is derived data outside the project folder.
- Anchors: per-statement `{ line, column, assetGuid, graphId, nodeId, bodyLine? }` plus `//# sourceURL=babylonslate:///<assetGuid>.js`. Anchor tables are position-based: any pass that moves lines must rewrite offsets. **Never minify compiled game scripts.**
- Exec flow compiles to native `if`/`for`/`while`; back-edges restart through labeled loops, not recursion. Pure data inlines with CSE.
- Latent work (Delay, async ExecuteJavaScript, latent Call Function, tweens, async loads) makes the entry `async`. Latency is transitive through Call Function and overrides. A node that emits `await` must call `ctx.requestAsync()` or declare `latent: true`. `ScriptHost` skips a latent entry that is still pending so Tick cannot stack runs.
- Impure output slots are declared once at the top of each entry (never inside a branch), named from the pin **id** (`_n_<node>_<pinId>`). Never introduce fixed-name temporaries outside a block.
- Read each input once per output or statement; bind multi-use inputs first so impure inputs (Random) sample once. Use `ctx.isWired(pinId)` (compiler's incoming-edge index), `ctx.hoist` for module-scope helpers and constants (deduplicated by name), `ctx.shared` for work shared between outputs.
- Editor/debugger compiles prepend `ctx.checkInfiniteLoop()` to impure emits and loop bodies; `ctx.checkInfiniteLoop` is always a function. `runtime.infinite_loop` stops Play immediately.
- **Development Only** (Print, Print String, Draw Debug by default) is stripped from release exports (`stripDevelopmentOnly`, derived from the same value as `bundleDebugger: false`); exec continues at `then`, data pins compile as type defaults. **Editor Only** nodes and EditorUtilityObject/EditorFunctionLibrary functions never reach runtime graphs.
- Custom events export the event name (`_` appended to JS reserved words); functions export by member name; Call uses `ctx.invokeFunction` / `ctx.invokeCustomEvent`; static Function Library calls pass the library class id.
- `GraphScriptCompileCache` keys exclude node positions (event and function graphs) but include members, defaults and saved parents.

## Runtime binding

- Lifecycle mapping: Actor/BObject → `onCreation` (Begin Play) / `onTick` / `onDestroyed`; GameInstance and GameSubsystem → `onInit` / `onTick` / `onEnd` plus scene events; SceneSubsystem → its own set. `changeScene` never dispatches `onEnd`; On End is the final lifecycle on every exit path.
- Play path: compile → worker `loadScripts` → `loadCompiledModule` (blob URL, `new Function` fallback) → `registerAnchors` → realize scene actors → tick.
- `ScriptHost` resolves exports along the class lineage: lifecycle, custom events, functions and interface handlers inherit; a child implementation replaces the ancestor's. Console commands, BT node events, Animation Graph events/rules and prefab data stay exact-id. Locked engine ids never inherit.
- `ctx` members that depend only on the host live on a shared prototype; `createContext` allocates per-call members only. Inherited members must never read `this`.
- Simulation time: every per-tick system uses the step captured when the tick began (`dt` × time dilation). Delay runs on the tick clock, never `setTimeout`. Pause reasons (`user`, `lifecycle`, `loading`; [`bridge/src/channels.ts`](../../../packages/bridge/src/channels.ts)) compose; Resume clears only its own. Custom JS timers and promises are cooperative, not suspended.
- Actor-pin helpers (`destroyActor`, `getComponent`, `setActorLocation`, `playParticles`, `moveTo`, …) never default a missing actor to Self: a wired reference that is null at runtime no-ops (or returns null). Nodes whose Actor pin means Self when unwired (Destroy Actor, Get/Has/Add Component, Play/Stop Particles, Attach To Bone `actor`) declare it with `selfActorPin` (`optional` + `selfWhenUnwired`, which the pin preview shows as Self) and compile it to `ctx.self` through `actorOrSelf` (both in `scripting-nodes/src/self-pin.ts`). `Target` pins on member nodes use the `implicitSelf` property instead, and their `ctx` helpers (`getVariableFrom`, `invokeFunction`, `callInterface`, …) keep `target ?? self`.
- Owner admission: calls into pending owners return output defaults; events do not run or queue. Destroying an actor while its Delay or continuation waits ends that graph silently.
- **Spawn Actor**, **Create Scene Layer**, **Set Material Instance**, texture parameters and console commands are latent and prepare resources first (`spawnActorAsync`, …); synchronous variants require prepared assets and report a cold-load error. `shouldSpawnScriptedActor` ([`play-load.ts`](../../../packages/runtime/src/play-load.ts)) never spawns GameInstance, libraries, editor objects, Scenes or subsystem lineages; `spawnActor` refuses `SceneLayerActor`.
- Load handles (Unreal StreamableManager style): opaque String handles; priority Low/Normal/High maps to background/preload/gameplay preparation; blocking loads share one `simulationBlocking` hold with blocking Scene streams; ownership follows the calling object, else Scene, else session.
- Component property Set is not store-only: `setVariableOn` routes to render commands, `PhysicsWorldSync.applyComponent` / `syncActor`, navigation `updateAgent` or audio gain. A property enters the catalog only when the Inspector serializes it **and** Play can apply it.
- Pose writes publish the body immediately so a Line Trace later in the same event sees it. Queries run against the caller's physics world (SceneLayer scripts see only their layer).
- Subsystems: only leaf classes are created; GameSubsystems before `World.start()`; SceneSubsystems per main Scene. A base with several leaves is `subsystem.ambiguous` in the editor; at runtime the first in class-id order wins with one warning.

## Editor surfaces

- Wiring rules: exec inputs fan in; each exec output drives one wire in the Class graph (`singleExecOutputOnConnect`); a new data wire replaces the old one; wires persist output→input.
- Generic catalog ids for Get/Set/Validated Get, Call Function, Call Custom Event, Cast, Make/Break, enum rows and Get `<Subsystem>` are hidden; the palette injects one row per member/class/type. Heavy injectors run only when Add Node opens and memoize on class-set identity.
- Hydrate regenerates member, struct, enum and interface pins from live schemas, keeps wires whose pin ids still match, and prunes the rest. Seeding of native events and Call Parent wiring runs on create, never on hydrate.
- Undo goes through `@babylonslate/edit` commands (`graph.setFunctionGraphs`, members, components); position drags commit once per gesture.
- Large lists (palette, Compiler Results) use the existing windowing components; do not add a virtualizer library.
- Play never writes unsaved edits without asking (Save & Play / Play Without Saving / Cancel).
