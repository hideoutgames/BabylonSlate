# Visual scripting (P5)

Shared surface for graph IR, pin types, validation, and JS codegen (engineplan §6, §6.1–6.2, §9.7 anchors, checklist `p5-*`). New packages: `@babylonslate/scripting`, `@babylonslate/scripting-nodes`. Editor shell: `@babylonslate/graph-ui` + class / type asset panels in `apps/editor`.

P4 already owns stack→node mapping (`AnchorEntry`, `loadCompiledModule`, Preview session report). P5 fills the compiler that emits those anchors and the editor that navigates to them. ExecuteJavaScript hoist lines carry `bodyLine` so a runtime throw inside the user body maps to the CodeMirror line; tapping a session-report row opens the owning Class (or BehaviourTree) asset if needed. `Log` at Error severity is a session-report row (`runtime.log`), not only Output Log.

## Package boundaries

| Package | Owns | Must not import |
| --- | --- | --- |
| `scripting` | Graph IR, pin type system, type context, pure validator + rule hook, deterministic JS codegen + anchor table | React, Babylon, Capacitor |
| `scripting-nodes` | Data-driven node catalog (id, title, category, pins, codegen) | React, Babylon, Capacitor |
| `graph-ui` | Touch React Flow shell reusable by script / shader / anim / BT graphs; Blueprint node chrome; pin/wire colors via `--pin-*` tokens | Babylon, Capacitor |
| `core` | Shared `formatValue`, keyed `print-hud`, diagnostic / pin type primitives reused outside scripting | React, Babylon, Capacitor |
| `runtime` | Loads compiled modules, registers anchors, Log/Print/`drawDebug` command forwarding | Babylon, DOM |
| `apps/editor` | Class document, Class panel, Compiler Results, validation gates, type asset editors | Capacitor |

Add `scripting` / `scripting-nodes` to the ESLint pure-package allowlist beside `object-model` (same React/Babylon/Capacitor bans).

`scripting-nodes` depends on `scripting` (types + codegen helpers). `scripting` must not depend on `scripting-nodes` — the compiler takes a **node registry** injected at compile time so catalog categories stay independently testable. `scripting` may import `instrumentJsLoops` from `@babylonslate/debugger`; debugger does not import scripting.

## Graph IR

Replace today's placeholder `SerializedGraph` (untyped nodes + edges without pin ends) with a typed IR stored on the **Class** asset payload (every class parent: `BObject`, `Actor`, `ActorComponent`, `GameInstance`, `FunctionLibrary`, `EditorFunctionLibrary`, `BDebugCommand`, `EditorUtilityObject`, `BTTask`, `BTDecorator`, `BTService`, `BTComposite`). New files use `.class.babasset`. Legacy `type: "Graph"` / `.graph.babasset` still loads and rewrites to Class on save. Prefab + Components dock tabs appear only when Class ancestry includes **Actor**; other classes get Graph, Class, Inspector, and Compiler Results. **EditorUtilityObject** native events are **Event Editor On Begin Play** plus On Editor Startup / On Scene Open / On Scene Saved / On Editor Shutdown (not game Begin Play / Tick). Boot order is construct → Editor On Begin Play → On Editor Startup → optional On Scene Open. They run in the in-process editor ScriptHost when listed in Project Settings — see [editor-extensions.md](editor-extensions.md). **EditorFunctionLibrary** is an engine base (parent FunctionLibrary) offered in New Class; EFL Call Function rows appear only on editor graph hosts.

```ts
type PinKind = "exec" | "data";
type GraphPin = {
  id: string;
  name: string;
  kind: PinKind;
  direction: "in" | "out";
  type: PinType; // see types
  optional?: boolean;
  defaultValue?: unknown; // catalog fallback for unconnected pins
};
type GraphNode = {
  id: string;
  typeId: string; // catalog id, e.g. "flow.branch"
  position: { x: number; y: number };
  pins: GraphPin[];
  properties: Record<string, unknown>; // node-local (severity, body, async, default:pinName, …)
};
type GraphEdge = {
  id: string;
  sourceNodeId: string;
  sourcePinId: string;
  targetNodeId: string;
  targetPinId: string;
};
type LogicGraph = {
  id: string;
  kind: "event" | "function" | "macro";
  nodes: GraphNode[];
  edges: GraphEdge[];
};
```

Migration: bump graph asset schema; committed historical goldens under `packages/assets` migration chains (same pattern as P1). Keep a thin adapter from the old `SerializedGraph` until editor documents are migrated.

## Pin type system

Single module `packages/scripting/src/types.ts` (exhaustively tested, prefer fast-check for assignability).

| Family | Forms |
| --- | --- |
| Exec | `exec` |
| Primitives | `bool`, `int`, `float`, `string` |
| Math | `vec2`, `vec3`, `vec4`, `rotator`, `transform`, `color` |
| Refs | `objectRef(classId)`, `actorRef(classId)`, `classRef(classId)` (class value, not a live instance), `structRef(guid)`, `enumRef(guid)`, `assetRef(assetType)` (guid string constrained to one Content Browser type, e.g. `Audio`) |
| Containers | `array(T)`, `map(K, V)` |
| Other | `delegate(signature)`, `resolvingWildcard`, `boxedWildcard` |

**Assignability (summary):**

- `int` → `float` widening; never the reverse without an explicit cast node.
- Subclass object/actor refs **and** `classRef` values assignable to superclass pins of the same kind (via class hierarchy). `actorRef` may also flow into a wider `objectRef` when the source class is a subclass of the destination class; narrowing `objectRef` → `actorRef` requires Cast. A `classRef` is not an instance: it is not assignable to `objectRef` / `actorRef`.
- `structRef(guid)` / `enumRef(guid)` assignability is **exact guid match**. An empty guid (unbound picker stub) does not assign to a typed pin.
- Anything → `boxedWildcard`; never implicit unbox (use `WildcardTo*`).
- `resolvingWildcard` has no runtime value; resolution groups unify at validate/compile time.

### Two wildcards (do not conflate)

| Kind | Role | Runtime |
| --- | --- | --- |
| Resolving | Compile-time generic for container nodes (Get, Append, Map Find) | None — pins adopt concrete type of first connection; group must agree |
| Boxed | Tagged any for Print and user wildcard params | `{ tag, value }` |

**Resolution** (`packages/scripting/src/wildcard-resolve.ts`): `resolveWildcardPinTypes` is a view over declared pins + edges. It does not rewrite stored `__pins`.

- All `resolvingWildcard` slots on a node share one variable `T` unless the type sets `group` (default `"T"`). Nested `array<T>` / `map<K,V>` walk into those slots.
- Incoming (input) connections are hard constraints. Two incompatible concretes in one group unbind `T` and emit `type.wildcard_group`. First compatible binding wins; `int` may still flow into an already-bound `float`.
- Outgoing connections infer `T` only when it is still unbound (so Array Get `out` → a float pin can resolve the node; Array Get `out` → a string pin after `T` is float is a `type.mismatch`, not a reset).
- Validator type-checks edges with **resolved** types (`float` → string after Get binds `T` is `type.mismatch`).
- Boxed pins stay `boxedWildcard` for typing. **Display** type follows the connected peer so Print’s value pin uses that peer’s `--pin-*` color. Disconnecting restores the unbound wildcard color.

Generated conversion family (`WildcardToString`, `WildcardToFloat`, …, `WildcardTypeOf`, `WildcardIs`) from the type table. Test: every registered concrete type has a converter. Failures expose success + fallback outputs (except `WildcardToString`, which always succeeds via `formatValue`).

### `formatValue` (`@babylonslate/core`)

Deterministic stringification shared by Log and Print. Golden-tested for structs, enums, arrays, maps, and object refs (`ClassName` + guid). Lives in `core` so runtime and scripting both depend on one implementation.

## Validator

Pure function: `(graphs, TypeContext, registeredRules) → Diagnostic[]`.

```ts
type Diagnostic = {
  severity: "error" | "warning" | "info";
  code: string; // e.g. "type.mismatch"
  message: string;
  assetGuid: string;
  graphId: string;
  nodeId?: string;
  pinId?: string;
  relatedNodeId?: string;
  // ExecuteJavaScript body errors:
  bodyLine?: number;
  bodyColumn?: number;
};
```

**Rule registration hook:** `registerValidationRule(rule)` so `behaviour-tree` adds BT structural rules without a second linter. `@babylonslate/behaviour-tree` calls `registerBehaviourTreeValidationRules()`; `TypeContext.behaviourTree` carries the tree payload. See [behaviour-tree.md](behaviour-tree.md).

**Rule groups (engineplan §6.2):** structural, pin typing, references (needs registry), signatures (needs class graph), semantic, ExecuteJavaScript parse, BT (later).

**When it runs:**

| Trigger | Scope |
| --- | --- |
| Edit (≈300ms debounce) | Open graph |
| Save | Document + dependents with reference diagnostics |
| Pre-Preview | Project graphs compiled for Play (`collectPlayPreviewScripts`), including Class/Graph documents and AnimationGraph Animation Object / transition-rule scripts; Play loads the seed from **Play from Scene** (open tab or `startupSceneGuid`). No seed → Play disabled. Enabled plugin Class graphs participate via `registry.list()`; plugin EUOs stay on the editor ScriptHost ([plugins.md](plugins.md)) |
| Export | Hard gate + export-only rules (debug-tier commands); Development Only nodes stripped by codegen |
| CI | Golden fixture projects |

Warnings never block. Errors block Preview via dialog (tap-to-navigate + **Play Anyway** + Engine Settings "don't ask again"), not a hard refuse. Tap-to-navigate focuses the node **and activates that graph tab** (so a background Class document is shown even when a scene tab was active for Play). Export-preset-only rules stay off the edit-time path.

## Compiler

IR → **plain JavaScript ES modules** (no TypeScript in the browser).

| Concern | Behaviour |
| --- | --- |
| Exec flow | Straight-line statements; Branch/Sequence/loops → native `if`/`for`/`while` |
| Pure data | Inlined expressions + CSE |
| Latent (Delay, Timeline, async ExecuteJavaScript) | Async generator state machines |
| FunctionLibrary | Module of static functions (EditorFunctionLibrary is editor-only) |
| Determinism | Stable text; golden tests are the primary gate |
| Anchors | Per-statement `{ line, column, assetGuid, graphId, nodeId, bodyLine? }` + `//# sourceURL=babylonslate:///<assetGuid>.js` |
| Load | `runtime.loadCompiledModule` (blob URL, `new Function` fallback) |
| Development Only | `properties.developmentOnly` wins when set. Otherwise `NodeDefinition.developmentOnlyByDefault` (Print, Print String, Draw Debug) is true. Canvas nodes draw a Unreal-style yellow/black hazard-tape footer. Editor Play and Preview keep the node. Export `compileGraphDocumentsForExport` (`stripDevelopmentOnly: true`) skips codegen and continues exec at `then`, or Sequence `then_*` pins in order (skip as no-op). Exclusive Branch `true`/`false` arms are not entered. Data pins from a stripped node compile as type defaults. A flagged event entry is omitted from the export module. Unchecking the Inspector box compiles the node into Release Export; the packed player still draws Print HUD and debug wireframes without `bundleDebugger`. |
| Editor Only | `NodeDefinition.editorOnly` on catalog defs (editor lifecycle events). Not a user Inspector flag. Hydrate stamps `data.__editorOnly`. Canvas cyan/black hazard-tape footer (`--node-editor-only-tape` / `--node-editor-only-stripe`). Runtime graphs never see editor-only types or their functions. |
| Output location | Derived data outside the project folder (compiled scripts + anchor tables) |

Validator and compiler share the **type context builder** so a graph that validates compiles.

Anchor tables are position-based: any pass that moves generated lines (packed export concat) must rewrite offsets. Never minify compiled game scripts.

## Special nodes (§6.1)

Ship with the catalog but own dedicated designs (not one-line templates):

| Node | Notes |
| --- | --- |
| **ExecuteJavaScript** | Editable in/out pin lists (JS identifier validation); fixed exec in/out; body → module-scope named function whose first argument is `ctx` (then user inputs) with defaulted outputs; async → latent; CodeMirror 6 body editor (lazy, accessory key bar, selection enabled); parse errors → Compiler Results with `bodyLine`/`bodyColumn`; runtime stacks on hoisted body lines carry `bodyLine` for session-report navigation. Editor compiles rewrite `while` / `for` / `do` in the hoist via `instrumentJsLoops` so `ctx.checkInfiniteLoop()` runs each iteration |
| **Log** | Severity + category → runtime log / Output Log / ring buffer; Error severity also enters the Preview session report (`runtime.log`) |
| **Print** | `debug.print`. Optional boxed `Value` (unconnected → `""`) via `formatValue` — wire Float/Int/Vec3 without a box/cast node. Catalog defaults: Key `""`, Duration `2`, Color opaque white. Overlay treats `duration <= 0` as one frame and missing/zero alpha as opaque white so old compiled `0` graphs still flash. Keyed registry replaces in place (`packages/core` `print-hud`, shared by editor overlay and packed player). Overlay Play and the packed player expire rows with `setTimeout` to the soonest `expiresAt` (`nextPrintHudTimeoutMs`) — they do not rewrite HUD chrome every frame. Worker sends `{ type: "print" }`; HUD is **not** gated by `bundleDebugger`. **Development Only** by default |
| **Print String** | `debug.printString`. Optional `In String` (default `""`); same Key / Duration / Color. Codegen `ctx.print(inString, …)` with no `formatValue`. **Development Only** by default |
| **Draw Debug** | `packages/scripting-nodes/src/debug-draw.ts`: Line, Point, Box, Sphere, Circle, Rectangle, Square, Cone, Cylinder, Arrow, Frustum, Coordinate System. World-space wireframes (`ctx.drawDebug` → `{ type: "debugDraw" }`), not editor gizmos and not GUI. Shared Color white, Duration `0` (one sim tick / Tick-friendly — not one engine present). Line Thickness default `1`. **Development Only** by default; uncheck to ship |
| **ExecuteConsoleCommand** | Runs through `@babylonslate/debugger` command registry; returns success + output; compile-time warning when a literal names a debug-tier command |
| **Event On Command Run** | `BDebugCommand` entry; output pins from the parameter list; compiles to `onCommandRun` |
| **Custom Event** | Class Events `flow.event.custom`: Then plus data **outputs** from member `pins[]`; outputs read `ctx.commandArgs` |
| **Call Custom Event** | `flow.event.call`: same-class / inherited Calls omit Target (`implicitSelf`, `ctx.self`); other-class Calls require Target. Data **inputs** + Then. Display title is `Call <Name>` (not Event-prefixed). Codegen `ctx.invokeCustomEvent`. Hidden as a generic catalog id; palette injects one row per event. Call nodes are not Class Events members (`flow.event.call` and `flow.event.callParent` skipped in the Events tree) |
| **Call Parent Event** | `flow.event.callParent`: title `Call <Event> Parent`. Exec in/out plus data **in and out** matching the event’s outputs (passthrough after parent runs). Codegen `ctx.invokeEvent(parentClassId, exportName, args)`. Hidden generic catalog id. Brown title bar (`--node-call-parent`). Seeded on new Class graphs (and when placing a missing Event stub) wired from Event Then; user may delete or move later without re-seeding on hydrate |
| **Call Function** | `functions.call`: same injection for class-owned functions (local + inherited + other open Classes). Same-class Calls omit Target; other-class Calls require Target. Signature data ins/outs. Codegen `ctx.invokeFunction`. When the target Function contains Delay (or other latent work, including a nested Call to a latent Function), Call emits `await ctx.invokeFunction`, the caller entry is `async`, `then` and data outs resume after the wait, and Tick pending applies to the **caller** — the Call node is latent chrome (`--node-latent`), like Delay. Sync Functions stay sync (`invokeFunction` without `await`). Generic catalog **Call** is hidden. **FunctionLibrary / EditorFunctionLibrary** inject static Call Function rows (`implicitSelf` + `static`, no Target pin) from open FL documents **and** the header signature index (`header.payload.functions` via `functionLibraryHeaderMeta` on save). Codegen `ctx.invokeFunction("MathLib", "Add", …)`. EFL rows only on editor hosts (`isEditorGraphHost`). |
| **Call I `<Method>`** | `interface.call`: generic catalog id hidden. Palette injects one row per ScriptInterface method (`Call I Apply Damage`). Target `objectRef(BObject)` (unconnected uses `ctx.self`). Signature pins from the method; guid/method live in node data. Codegen `ctx.callInterface(target, guid, method, args)`. Legacy guid/method string pins still compile. |
| **Get Variable** | Bound `variables.get`: typed data **out** named after the variable (`id` stays `value`); Target only when `implicitSelf !== true`. Palette injects `variables.get:Class:Name` per class / inherited / other-open-Class member. Function locals appear only while that function graph is open. Generic catalog id is hidden. Self codegen `ctx.getVariable`; Target `ctx.getVariableFrom`; locals read `__lv_Name` |
| **Validated Get** | Bound `variables.getValidated` for **single** object/actor instance variables (not `class` / asset / Array / Map). Exec in, exec outs **Is Valid** / **Not Valid** (ids `isValid` / `notValid`), optional Target (same `implicitSelf` as Get), typed value out named after the variable. Compile assigns the same get expr as Get Variable, then `if (value != null)` follows Is Valid else Not Valid — `undefined` and `null` are Not Valid (no `destroyed` check). Generic catalog id is hidden; palette injects `variables.getValidated:Class:Name`. Drag-drop chooser offers Validated Get for those members |
| **Is Valid** | Pure `actor.isValid` (`IsValid(Object)`): Object in (`objectRef(BObject)`, pin id `target`, display **Object**), bool out. Codegen `target != null`. Stays in Add Node on BObject and Actor hosts. Not a second Validated Get |
| **Set Variable** | Bound `variables.set`: exec / then, typed value in + pass-through out **named after the variable** (`id`s stay `value` / `out`); same Target and palette rules (`variables.set:Class:Name`). Self `ctx.setVariable`; Target `ctx.setVariableOn`; locals assign `__lv_Name`. Pass-through writes the Set output slot |
| **Cast to `<Class>`** | Dynamic `casting.cast`: exec / then, live-object in (`objectRef(BObject)`), Class in (`classRef(BObject)` with a literal default), Success bool, Result out. Wire exec through the node. Unconnected Class titles the node `Cast to Hero` and types Result as `actorRef` when the default class is Actor ancestry, otherwise `objectRef`. A wired Class pin titles it `Cast to Class` and types Result from the connected constraint (or `BObject`). Generic catalog ids `casting.cast` / `casting.castActor` are hidden; Add Node injects one searchable row per known engine/project class. Codegen `ctx.isA(instance, classId)` via `ClassRegistry.isA`. Old `casting.castActor` graphs still load as data-only. |
| **Make / Break Structure** | Generic `struct.make` / `struct.break` are hidden. Palette injects `Make <Name>` / `Break <Name>` (`struct.make:<guid>`) per project Structure (and future engine user-style structs in `ENGINE_STRUCTS`). Pins come from a field snapshot so `pins(properties)` runs without TypeContext; hydrate regenerates from the live schema, **keeps wires whose pin ids still match field names**, and **drops** edges to renamed or removed fields. Make: one data in per field + struct out (`{ Field: … }`). Break: struct in + one data out per field (`(in).Field`). Empty struct is `{}`. Field pin **ids** stay the field name (codegen / `default:` keys); pin **display** is Title Case (`maxHealth` → Max Health). Engine pin-kind math stays first-class: **Make/Break Rotator**, **Color**, **Transform**, plus **Break Vector2 / Vector4**. Transform graph pins are Location `vec3`, Rotation `rotator` (Euler degrees), Scale `vec3` (ids `location` / `rotation` / `scale`); codegen writes `{ position, rotation: quat, scale }` to match `identityTransform()` / `transform.get`. Context-sensitive Add Node **prefers** the matching Make/Break row for a dragged `structRef` pin. |
| **Make Enum / Equal / Switch / Select** | Generic `enum.make`, `enum.equals`, `enum.notEquals`, `enum.toString`, `enum.switch`, `enum.select` stay in the catalog. Palette also injects `Make <Name>` / `Equal <Name>` / `Switch on <Name>` / `Select <Name>` with `enumGuid` prefilled. Runtime enum values are **member name strings**; Details Selects Title Case the option labels. Switch exec outs are one per member plus **Default**; pin ids are `case:<member>` so compile can compare `value === "Member"` even when the label is Title Case. **Select** takes one enum Index plus one resolving-wildcard option per member (shared group with Out; option pins are optional so unused members do not warn `pin.missing_input`); Index default binds to the first member. Connecting an `enumRef` pin copies that guid onto the node and rebuilds pins; disconnect keeps the last guid and re-enables Details. Type Select is disabled while a wired pin supplies a guid. Hydrate **drops** Switch case / Select option wires whose member pin no longer exists. Context-sensitive Add Node **prefers** matching Switch / Equal / Make / Select rows for a dragged `enumRef` pin. |
| **Switch on Int / String** | `flow.switchInt` / `flow.switchString`: exec in, typed selector (`int` / `string`), property-driven `cases[]`, one exec out per case plus **Default**. Case pin ids are `case:` + `encodeURIComponent(value)` (stable across special characters). Hydrate / materialize regenerate pins from the same normalized case list (drop empty / invalid / duplicates, warn via `flow.switch.*`), keep matching case wires, and prune removed ones. Compiler emits if/else via `structuredFlow` (`switchOnInt` / `switchOnString`). Inspector edits cases with `NamedListEditor`. Context-sensitive Add Node **prefers** these nodes for dragged int / string pins. |
| **Structured loops** | For Loop, For Each, and For Each Map each have normal and **With Break** variants. They compile to native loops with Loop Body and Completed exec outs plus Index / Element / Key / Value data outs. Array/Map iteration snapshots the container before entering; Map follows insertion order. Completed runs after exhaustion or Break. Editor/debug builds insert `ctx.checkInfiniteLoop()` per iteration. `flow.break` outside a With Break body emits `flow.break_outside_loop`. |
| **Stateful flow** | Do Once, Do N, Flip Flop, and Gate compile through `structuredFlow`. Mutable state lives in `ScriptHost.flowState`, namespaced by compiled script + node and isolated per receiving object; actor destruction clears it. Reset/Open/Close/Toggle exec inputs are distinguished by the incoming handle, not a module global. |
| **Format String** | `string.format`: Format string pin (default `{input}`) plus one boxed-wildcard arg pin per unique nonempty `{placeholder}` (including `{0}`, `{#}`, `{input pin}`; repeated names share a pin; doubled opening or closing braces escape a literal brace). Arg pin ids are `arg:` + `encodeURIComponent(name)`. Codegen concatenates literals with `ctx.formatValue` per arg. When Format is **wired**, dynamic arg pins are omitted and stale arg edges are pruned; disconnect restores args from the retained `default:format`. |
| **Select (typed)** | Fixed pure nodes `select.bool` / `int` / `float` / `string` / `vec2` / `vec3` / `vec4` / `rotator` / `transform` / `color`. Every node takes a Bool **Index**, typed **False** / **True** defaults, and one typed output. Category `select`; dynamic Enum/Object/Class/Struct selection uses `enum.select` instead of fixed variants. |
| **Report Command** | Sets the console success flag + output string for `OnCommandRun` |

Shared **PinListEditor** / **PinTypePicker** in `editor-kit` author typed named reorderable pins (color chip, compact type picker, up/down, trash icon, Class Type on object/class pins, Structure/Enum `AssetPicker` on struct/enum pins when `typeAssets` is passed). `ParameterListEditor` is a thin wrapper for ExecuteJavaScript Inputs/Outputs and `BDebugCommand` / Event On Command Run (Execute JS enums still use the NamedListEditor value list). Class function signatures and ScriptInterface method pins use `PinListEditor` directly. `GraphClassMember.typeClassId` is the object/class constraint **or** the Structure/Enum asset guid (including `engine:` registry ids). `pinTypeForMember(typeId, typeClassId)` emits `structRef(guid)` / `enumRef(guid)`; an empty guid is an unbound stub.

## Node catalog (`scripting-nodes`)

One module + one test file per category:

`flow` (Branch / Sequence, Switch on Int/String, For Loop / For Each / For Each Map with Break variants, **While Loop** (`flow.whileLoop`, compiled to a native `while` with Loop Body / Completed), Do Once / Do N / Flip Flop / Gate), `math` (add/sub/mul/div plus **Lerp / Clamp / Min / Max / Sin / Cos / Degrees / Radians / Floor / Ceil / Random Float** via `ctx.randomFloat()`), `vector` (Make/Break Vector2/3/4 plus subtract/multiply/divide/dot/cross/length/normalize/distance/lerp/scale), `literal` (**Make Bool / Int / Float / String / Class / Asset / Quaternion**; **To String** for bool/int/float/vec2/3/4/rotator/color — unconnected Make inputs use pin defaults; wired inputs pass through; To String uses `ctx.formatValue`), `string` (Concat / Length / Equals / **Format String**), `select` (**Select Bool** plus typed Select Int/Float/String/Vector2/3/4/Rotator/Transform/Color and dynamic **enum.select**), `array`/`map` (`array.get` / `length` / `append` / `contains` plus **Make Array**, **Array Set / Insert / Remove Index / Find / Clear**; `map.get` / `set` / `has` / `remove` / `size` / `keys` plus **Make Map**, **Map Values / Clear**), `actor`, `component`, `rotator` (**Make/Break Rotator** keep `struct.makeRotator` ids; Combine / Delta / Inverse / Lerp / Forward / Right / Up / Look At / Nearly Equal via `ctx.combineRotators` and peers), `quaternion` (**Make/Break Quaternion**, Rotator To Quaternion / Quaternion To Rotator, Multiply / Inverse / Slerp / Rotate Vector / Normalize via `ctx.multiplyQuats` and peers), `color` (**Make/Break Color** plus Lerp / Multiply / Nearly Equal), `transform` (Get/Set Actor Location, Rotation, Scale, Transform; Get Actor Forward/Right/Up; Make/Break Transform), `physics` (Line Trace / Shape Sweep / Sphere Overlap output `engine:HitResult` plus exploded aliases and optional `engine:CollisionChannel`; Add Impulse — sync on calling exec pin), `input` (OnAction / IsActionHeld / GetAxis / GetAxis2D, **Get Cursor Position / Project Cursor To Scene / Show Cursor / Hide Cursor**, gamepad connected/disconnected, rumble), `audio` (Play Sound, Set Channel Volume, Set Global Volume), `particles` (Play Particles / Stop Particles), `scene`, `camera` / `light` (Possess Camera, get/set FOV and orthographic size, set light enabled/color/intensity), `debug`, `interface`, `variables` (bound Get/Set/Validated Get; generic catalog ids hidden — palette injects per class member and per open-function local; pin type follows variable **Container**; Validated Get only for single object/actor), `casting` (`Cast to <Class>` rows injected per known class; generic `casting.cast` / `casting.castActor` hidden), `struct` (hidden `struct.make` / `struct.break` injected per Structure including **Hit Result**; engine Make/Break Rotator, Color, Transform live under rotator/color/transform), `enum` (Make / Equal / Not Equal / to String / Switch on Enum / **Select**; palette also injects typed rows per Enum), `timers`, `functions` (Call Function; generic catalog id hidden — palette injects per class member), `behaviour-tree` (On Activate / On Tick / On Abort / On Evaluate / Finish Execute / Return Condition / Get Blackboard / Set Blackboard), `navigation` (FindPathTo, MoveTo, StopMovement, path queries, obstacle add/remove).

Each node: `{ id, title, category, pins, codegen(ctx) }`. Physics/input nodes may register with compile-time "not yet available" or emit TODOs that fail validation until those phases — prefer stub codegen that throws a clear diagnostic over silently no-op.

**Completeness contract.** Container updates are immutable outputs: authors wire the returned Array/Map into Set Variable when they want to retain it. Array includes safe Get, validity/empty/index queries, append Array, set/insert/remove, reverse/slice, First/Last, and dynamic Make Array. Map includes Get + Found, Remove + Removed, empty/clear, Keys, Values, Break Map, and dynamic Make Map. Constructor Item/Pair counts are edited in Inspector; hydrate regenerates stable pins and prunes removed handles. Missing Get/First/Last values compile to the resolved type default rather than `undefined`.

String utilities cover contains/prefix/suffix, replace/split/join/substring/trim/case, and parse Int/Float with Success. Math adds integer parity, equal/not-equal, sign/power/square-root/round, and deterministic Random Float/Int/Bool through the runtime seed. Vector2/3/4 cover arithmetic, dot, length/length-squared, distance, safe normalize, and lerp (Vector3 also Cross). Transform adds world offset; Actor queries return the first/all live instances of a class in deterministic spawn order using ClassRegistry ancestry.

AI / navigation categories: behaviour-tree event/finish/return/blackboard nodes plus `navigation.*` (FindPathTo, MoveTo, StopMovement, path queries, obstacle add/remove). `scripting-nodes` emits `ctx.*` only — Recast stays in `@babylonslate/navigation` / runtime. **Return Condition** (`bt.returnCondition`) is exec in + bool in → `ctx.btEvaluate(bool)` (On Evaluate has exec-out only). **Get/Set Blackboard** (`bt.blackboard.get` / `bt.blackboard.set`) mirror variable nodes onto `ctx.getBlackboard` / `ctx.setBlackboard`. Class Add Node palettes filter by parent ancestry: Actor graphs hide `bt.event.*` / finish / return / blackboard; `BTTask` gets activate/tick/abort + finish + blackboard; `BTDecorator` gets evaluate + return + blackboard; `BTService` gets tick + blackboard; `BTComposite` hides Actor and BT leaf events.

**Audio** (`audio.play` / `audio.setChannelVolume` / `audio.setGlobalVolume`) lives on Class and Actor palettes. Play Sound takes an `assetRef("Audio")` pin and Volume default `1`, and emits `playSound` with `self` as emitter (no Loop pin — the Audio asset’s `loop` flag applies; `AudioComponent.loop` still forces loop). Set Channel / Set Global clamp `0..1`, replace session mixer values, and update voices that are already playing (warned no-op without a selected mixer / unknown channel). Inspector maps `assetRef` pins to `AssetPicker` with `allowedTypes`. See [audio.md](audio.md).

**Particles** (`particles.play` / `particles.stop`) live on Class and Actor palettes. Optional `actorRef("Actor")` (unconnected → `ctx.self`) emits `setParticlePlaying`. See [particles.md](particles.md).

### Editor-only graphs

`NodeDefinition.editorOnly` marks real editor-only catalog nodes (editor lifecycle events). Helpers `isEditorGraphHost` / `isEditorGraphClass` / `isEditorFunctionLibraryClass` live in `packages/core/src/editor-only.ts`. Runtime graphs never see EditorUtilityObject / EditorFunctionLibrary **or their functions**, even with Context Sensitive off. See [editor-extensions.md](editor-extensions.md).

## Editor surfaces

### Class document

- **Graph** canvas (event + per-function graphs). **Double-tap empty pane**, empty-pane right-click / long-press, and the toolbar **+** (`graph-add-node`) open Add Node (`Dialog` with categories + search; search is **not** autofocused). Default menu is all **host-legal** nodes (not the whole engine catalog). Footer **Context Sensitive** (`data-testid="node-palette-context-sensitive"`, default ON): pin-drag / pin filter applies only when on. Search and category reset every time the dialog opens. Category counts (including All) follow the search-filtered set. `NodePalette` windows the catalog body (`p18-add-node-virtualize`; viewport plus overscan, `--touch-target` 44px rows) so a ~1000-node palette stays cheap. Search, category counts, Context Sensitive, and pin-filter still run over the full in-memory list. Distinct from `p18-graph-virtualize` (canvas). **P20** (`p20-palette-generate`, **Done**) defers heavy `scriptPaletteNodes` injectors until Add Node opens and memoizes on class-set / FL / member identity, not every pin edit. Drag-to-connect and tap-to-connect both persist. Exec pins accept multiple wires in and out; a second data wire onto the same input **replaces** the previous. Pin-drag Add Node uses a 96px screen-space safe zone around the source pin and compatible pins; a live **Tap to Cancel** hint follows the wire in that zone. **Releasing** in that zone opens Add Node; a **second pointer** while the drag is held cancels the rubber-band and does not open the catalog. The pick spawns at the wire-end flow position (`screenToFlowPosition` of the drag pointer) and auto-wires. A cancelled pin drag (no snap, no Add Node, pointer left the source handle) breaks every wire on that pin. Pin visuals are hollow until connected (`data-pin-connected="false"|"true"`).
- **Class**: My Blueprint member tree (Functions, Variables, Events, Interfaces — empty sections stay visible; no Graphs section) stacked *under* Components, about 50% of the left stack. **FunctionLibrary / EditorFunctionLibrary** show Functions + Local Variables (when a function graph is open) only — no events, member variables, or interfaces. Empty event graph has no native events; empty state tells the user to add a function. Each section row has a trailing **+** (`IconActionButton`); Functions **+** opens **Add Function** (`AddFunctionDialog`: **New Empty Function**, then a scrollable list of overridable parent functions and ScriptInterface methods — overwritten rows are muted). Events **+** reuses the same dialog as **Add Event** (bounded native overflow list: native host events including **Event On Actor Destroyed**, parent custom events titled **Event On Foo (Inherited)**, and attached-component events such as **Event On Click (2D Button)** / **Event On Begin Overlap (Collider)** / **Event On Text Changed (3D Text)** — one row per instance, greyed when that same binding is already on the graph). The Events tree lists only canvas event nodes (not unused natives or inherited customs). A deleted local custom event is not overridable on that class; descendants see it in Events **+** only while the declaring class still has the event. There is no toolbar Add dropdown or trash. Delete is the row context menu only. Rows use `TypeColorMark`. Writes `SerializedGraph.members` (variables: `typeId` + optional `typeClassId` for object/actor/class constraints, Content Browser asset kinds, **or** Structure/Enum guids, optional `container` `single`/`array`/`map` with Map `keyTypeId` / `keyTypeClassId`, + optional `defaultValue`; function locals: same kind with `functionId` pointing at the owning function member; functions: `pins[]` plus `functionGraphs[id]`, optional `overridable` (default off), optional `implementsInterface` / `overrides`; interfaces: ScriptInterface `assetGuid`; custom events: data `pins[]` mirrored onto the event node). Event names are Title Cased (`On Hit`; host node title `Event Begin Play`; component/inherited titles `Event On Hit (Collider)`, `Event On Click (2D Button)`, `Event On Foo (Inherited)`). Actor Class graphs also expose Get-only virtual object-ref variables for merged prefab components (`id` `component:${componentId}`, Title Case labels such as **Get 3D Text** / **Get 3D Text 2**, Inherited badge when merged from a parent). They are not stored in `members[]` and are not deletable except by removing the component. Get codegen is `ctx.getComponentById(ctx.self, componentId)`. Dragging off that pin injects Get/Set of that class’s engine script API variables and Call of its functions (`Set Text` → `ctx.callComponentFunction`). Custom events insert `flow.event.custom` (Then plus data **outputs**). **Call Custom Event** (`flow.event.call`), **Call Function** (`functions.call`), and bound **Get/Set/Validated Get Variable** (`variables.get` / `variables.set` / `variables.getValidated`) are injected into Add Node — one row per local/inherited member (`implicitSelf`, no Target pin) and per other open Class member (required Target). Generic catalog ids are hidden. **Drag a Class-panel row onto the graph** (pointer capture, not HTML5 DnD): custom events spawn Call Custom Event, functions spawn Call Function, variables/locals open a Get / Validated Get / Set `Dialog` then spawn at the drop; a floating drop hint shows `+` / ban while dragging. Call nodes are not Class members (`flow.event.call` and `flow.event.callParent` are skipped in the Events tree; functions already come from `members[]`). New function graphs seed protected Input/Output with Input Then wired to Output Exec on create (deleting the wire sticks — no hydrate re-seed). Call Custom Event has Then plus matching data **inputs**; Call Function also maps signature data **outputs**. FL/EFL also inject static Call Function rows from open FL docs and `header.payload.functions` (`functionLibraryHeaderMeta` on save): `implicitSelf` + `static`, no Target; codegen `ctx.invokeFunction("MathLib", "Add", …)`; EFL only on editor hosts. **Native events** in Events **+** follow parent ancestry: Actor lists Begin Play, Tick, and On Actor Destroyed (plus On Command Run when ancestry includes `BDebugCommand`); `BObject` / `GameInstance` / `ActorComponent` list none of those; `EditorUtilityObject` lists On Editor Startup / On Scene Open / On Scene Saved / On Editor Shutdown; `FunctionLibrary` / `EditorFunctionLibrary` list none; `BTTask` lists On Activate / On Tick / On Abort; `BTDecorator` lists On Evaluate; `BTService` lists On Tick; `BTComposite` lists none of those. Collision, overlay pointer, On Text Changed, and On Audio Finished are **not** host natives — they appear only when a matching component is attached (`ColliderComponent`, overlay-only `2DButtonComponent`, text components, `AudioComponent`). SceneLayerActor ancestry does not special-case mouse events. Picking a live row places the node (and Call Parent when a parent class is set). Parent Class variables, functions, and interfaces stay listed as inherited with a tiny **Inherited** badge (read-only; activate opens the declaring Class when it is not an engine-locked id). Parent custom events are not tree rows until overridden. Call Custom Event titles stay `Call <Name>` (never `Event Call …`); event Output edits sync onto the event node and matching Call inputs. **Local Variables** (trailing **+** `class-add-local-variables`) lists members with that function’s `functionId` and is hidden on the event graph. Selecting a variable or interface does **not** leave the open function graph; events still switch to the event graph. Variable row context menu **Get** / **Set** spawn bound nodes into the current slice. Rename/type on a variable syncs matching Get/Set/Validated Get nodes on the event graph and every `functionGraphs` slice. Selecting a function switches the Graph dock to that function’s Input/Output graph (`activeFunctionId`). `diffGraphCommands` emits `graph.setFunctionGraphs` so those slices survive undo. `flow.event.custom` compiles to a named export (`On_Hit` from "On Hit"); Call Custom Event codegen is `ctx.invokeCustomEvent(target, eventName, args)`. Function graphs compile to a named export from the member name; Call Function codegen is `ctx.invokeFunction(target, exportName, args)` (lookup by export name, not `point.event`); static FL calls pass the library class id as the first argument. Function locals compile as `let __lv_Name = <default>;` at the start of that export only (not `ScriptBundleEntry.variables`). Play dispatches custom events with `ScriptHost.invokeEvent(classId, event, self, args)`. Function Output nodes `return { pin: ctx.input(pin), … }` so Call can assign data outputs.
- **Details** (dock title Inspector): canvas selection drives the target (first selected node; Compiler Results / Play focus as fallback). A selected Class member (variable or function local) shows **VariableTypeFields**: Type (`PinTypePicker`, including Actor / Asset / Wildcard / Quaternion) plus **Single \| Array \| Map** (`ToggleGroup`). Map shows **Key Type**. Actor and Object/Class show **Class Type** (`ClassPicker`; Actor defaults to Actor). Asset shows **Asset Type** (`SearchDropdown` of Content Browser kinds). Struct/Enum show Structure/Enum `AssetPicker`. Changing Type or Container resets `defaultValue` (inner default, `[]`, or omit for Map). Array/Map have no Inspector literal Default in v1 — author via Make Array / Make Map. Single typed Default rows (`PropertyGrid`) stay for scalars/structs/enums; object/actor/wildcard/asset omit Default. A Class variable stores that class id as `defaultValue`. Closed Class Type / Script Interface / Structure / Enum buttons use `PickerIdentity`. Function **Inputs** and **Outputs** (`PinListEditor` with exec plus data types, trash-icon remove, Class Type on object/actor/class pins, Asset Type on asset pins, Structure/Enum AssetPicker on struct/enum pins) plus **Overridable** (default off). Interface implementations show **Interface Implementation**, lock Name/Inputs/Outputs, and omit Overridable. Interface `AssetPicker` for interface members. Selecting a Class-panel custom event focuses the canvas node; Details shows **Outputs** (`PinListEditor`, data types only — exec Then is implicit) and syncs pins onto matching Call nodes. Function signature edits also sync matching `functions.call` nodes. Empty selection shows an empty state — no ExecuteJavaScript fallback. Unconnected applicable data pins get literal defaults (`classRef` uses `ClassPicker` filtered to subclasses; the PropertyGrid trigger matches the modal row; `structRef` expands nested field rows); ExecuteJavaScript still has pin lists + body; Log has severity / category; enum nodes expose Enum Type (muted when a wired pin already supplies a guid) and Make Enum Value; every selected node has **Development Only** (Inspector flag). **Editor Only** is catalog-stamped (`NodeDefinition.editorOnly` → `data.__editorOnly`), not an Inspector checkbox.
- **Compiler Results**: diagnostics grouped by graph; tap → select node, pan canvas, flash pin (or scroll CodeMirror to `bodyLine`). Prefab / Class also merge physics pairing warnings (`physics.collider_without_body` / `physics.body_without_collider`; tap with `actorId` selects Prefab Root / the scene actor). `WindowedList` windows header + diagnostic rows (`data-testid="compiler-result-row"` on **mounted** diagnostics; `--touch-target` 44px). Render-all when measured height is 0. Do not add a virtualizer library.
- **Prefab** (Actor): full-size center tab; 3D preview + gizmos; per-component pick/gizmo; Prefab Root origin **is** the Scene actor origin. Component tree writes `SerializedGraph.components` including local `transform` (undo via `graph.setComponents`). Parent Class components merge in (Inherited badge; editable details/transform; not removable). Place Actors copies the merged list onto spawned Class actors. Prefab edits and Class undo/redo of that list then merge into placed actors of that class (instance overrides and extra components stay).
- **Components**: nested actor component tree (`parentId`) in the left dock; immediate drag-to-parent (row middle nests; top/bottom 8px insert as a sibling); Add Component uses the Place Actors catalog chrome (engine types including Skybox / **3D Text** plus a **Project** category). Project rows bind Model / Mesh onto `MeshComponent.assetGuid`, Audio onto `audioAssetGuid`, ParticleSystem onto `particleSystemGuid`, Sprite / Tilemap onto `assetGuid`, AnimationGraph onto `graphGuid`, BehaviourTree onto `treeGuid`. User Class assets whose ancestry includes `ActorComponent` and not `Actor` are listed; Actor classes stay Place Actors. Mesh is **Primitive or Model asset**. New rows parent under the selected component (or Prefab Root) and become the Inspector selection. Tree labels are Title Case catalog names, with `(Asset Name)` when a guid is bound. Multi-select matches Outliner (Ctrl/Shift/Meta, swipe add, two-finger range; additive Prefab Root is exclusive). Inspector **N Components** when more than one component is selected. Inherited rows cannot be deleted; Remove deletes every selected local component (and descendants).

### Type assets (Enum / Structure / ScriptInterface)

These open their own DockView documents (not compact Settings tabs). **Windows** lists their panels.

| Kind | Default panels |
| --- | --- |
| Enum | Members table (name + value) + Details |
| Structure | Member list with pin colors + Details (`PinTypePicker`, default) |
| ScriptInterface | Methods \| read-only function-node Preview (`GraphEditor` `readOnly`) \| pin Details (`PinListEditor` in/out) |

Texture stays compact `asset-settings`. Model, Skeleton, and Animation open DockView documents (Preview + Details). Imported Audio opens a DockView document (Preview / Details / Clips). Sprite opens a DockView document (Preview + Details). FunctionLibrary remains a Class parent, not a file type.

### `graph-ui` rework

Touch-first React Flow 12 shell (`@babylonslate/graph-ui`):

- **`GraphEditor` props** (all optional except `initialGraph`): `onChange`, `onSelectionChange` (selected node ids; select-only and dimension-only changes do not call `onChange`), `onEdgeSelectionChange` / `onEdgeDoubleClick`, `edgeTypes` / `defaultEdgeOptions` (Animation Graph uses `{ type: "animTransition" }`), `focusedNodeId` (select + fit/pan), `diagnostics` (red node badges for `severity: "error"`), `onNavigateRequest`, `paletteNodes` + centered **Add node** catalog modal (opened by toolbar **+**, double-tap pane, empty-pane context menu, or a far pin-drag release; not a persistent floating button), `defaultZoom` (opening / Controls / focused-node fit-view cap; default 0.5 from Engine Settings `graphDefaultZoom`), `readOnly` (ScriptInterface signature preview: pan/zoom only; no connect, node drag, palette, or Cut/Paste/Delete/Format). Small graphs do not zoom in past that value; large graphs still fit down to min zoom 0.1. External `initialGraph` updates (undo/redo, Inspector, Class members) reconcile onto the canvas without emitting `onChange`; parent echoes of the last emit are ignored so a drag is not snapped back.
- **`GraphDocument`**: local extension of core `SerializedGraph`; edges may carry optional `sourceHandle` / `targetHandle` for pin-aware wiring and optional `type` (React Flow edge component; Animation Graph persists `"animTransition"`). Optional `members` round-trip Class panel rows; optional `components` round-trip Actor prefab rows; optional `functionGraphs` hold per-function Input/Output graphs. `data.__protected` Input/Output nodes are movable but not deleted, copied, cut, or duplicated.
- **Nodes**: scripting nodes render via `PinNode` when `data.__pins` is present. Chrome is Blueprint-like: role-colored title bar (`--node-*`) clipped to the shell radius (`overflow-hidden` + `rounded-t-lg`) while the error badge sits outside that clip, two-column pin rows (`zipPinRows` packs leftover data pins into empty opposite-side cells on extra exec rows, so Branch Condition sits beside False), exec diamonds, data circles, and array list bars. Pin visuals stay hollow until a wire lands (`data-pin-connected="false"|"true"`), then fill. Default shell min-width is `min-w-80` (compact BT `min-w-56`); titles use `text-base`. Each pin row is `--touch-target` (44px) tall; the visual pin is `--graph-pin-size` (22px); pin names use `text-base`. Unconnected literal data inputs show a compact read-only default preview between the hollow pin and the name (`data-pin-default`; bool checkbox and color swatch at `size-5`, or a `text-base` / `h-8` truncated field capped at `--graph-pin-default-max-width`). Previews are not inputs (`pointer-events-none`); wiring the pin hides them. Titles wrap; `flow.event.*` without `data.title` formats as **Event …**. Tap output pin → tap input pin to connect. Legacy `logMessage` without pins still uses the same shell until the host hydrates. Development Only and Editor Only (`data.__editorOnly`) draw hazard-tape footers.
- **Host pin hydration** (`hydrateSerializedGraphForEditor` in the editor): injects `__pins` plus `__category` / `__pure` / `__latent` from `@babylonslate/scripting-nodes` on load; stamps `data.__editorOnly` from `editorOnly` defs. Print, Print String, and Draw Debug (Development Only by default) regenerate `__pins` from the live catalog so canvas Duration / Color previews pick up `GraphPin.defaultValue` on graphs that stored pins without it. Authored `default:*` properties are kept. Palette entries carry `pins`, `pure`, `latent`, `editorOnly`, and `defaultData` so Add node creates connectable, colored handles. `graph-ui` stays free of the catalog package. It depends on `@babylonslate/scripting` for `resolveWildcardPinTypes` (pin/wire colors follow resolved display types without persisting them), Development Only detection, and literal pin-default preview values.
- **New graphs** seed native events from `nativeEventStubs` via `createDefaultLogicGraphSerialized` (Actor: Begin Play + Tick, not On Actor Destroyed; EditorUtilityObject: Editor On Begin Play + session events; BT parents as in Class Events; FunctionLibrary / EditorFunctionLibrary / BObject: empty). When a parent class is set, each seeded Event is default-wired to **Call &lt;Event&gt; Parent** (`flow.event.callParent` → `ctx.invokeEvent(parentClassId, …)`); inherited custom events from parent graphs are also placed and wired the same way. Seeding runs on create / first Event place only — not on hydrate — so deleting or moving Call Parent sticks. Existing `logMessage` graphs hydrate to `debug.log` pins without auto-injecting events. Class Add Node uses `scriptPaletteNodes({ parentClass, parentOf, classId, graph, otherClassGraphs, activeFunctionId, functionLibraries, animationGraphHost, assetType })` so BT leaf events do not appear on Actor graphs, editor-only defs stay off runtime hosts, Animation Graph Object/rule palettes stay exclusive (`"object"`: `anim.event.*` + runtime nodes; `"rule"`: `anim.state.*` + pure + Get Variable), and Call Custom Event / Call Function / Get Variable / Set Variable / Validated Get / **Cast to `<Class>`** rows are injected per class member or known class (locals only when that function graph is open). Actor palettes hide all `anim.*`. Closed Class headers participate in the symbol table (`classHeaderMeta`) so Get/Set/Call and Cast rows do not require the target Class tab to be open. Static FL Call Function rows come from open FL docs and `header.payload.functions`. Hydrate regenerates `flow.event.call`, `flow.event.callParent`, `functions.call`, `flow.function.input`, `flow.function.output`, `variables.get`, `variables.set`, `variables.getValidated`, `casting.cast`, `string.format`, `enum.select`, `array.make`, `map.make`, `flow.switchInt`, `flow.switchString`, and Development-Only-by-default nodes (Print, Print String, Draw Debug) pins so type, Target, Class function Input/Output, Cast Result handles, dynamic constructors, and catalog pin defaults stay in sync. Unconnected Cast nodes retitle to `Cast to <Class>`; a wired Class pin retitles to `Cast to Class`. **P20 residual:** `scriptPaletteNodes` still rebuilds those injectors in `graph-panel` `useMemo` on graph content while Add Node is closed (`p20-palette-generate` defers until open and memoizes on class-set / FL / member identity).
- **Undo**: `AddNodeCommand` / `RemoveNodeCommand` / `SetGraphMembersCommand` / `SetGraphComponentsCommand` / `SetGraphFunctionGraphsCommand` (`graph.setFunctionGraphs`) in `@babylonslate/edit` so palette adds, Class panel members, function slices, and prefab components persist through `diffGraphCommands`. Chrome Undo/Redo (and desktop Mod+Z / Mod+Shift+Z / Mod+Y) apply that stack to the document **and** the canvas via GraphEditor reconcile. The Class graph panel hydrates from document **content** identity (`updateGraph` mutates the open-doc wrapper in place). Shader and Animation Graph Object share the same shell. Animation Graph State Machine uses custom `anim.state` nodes and `animTransition` edges.
- Tap-to-connect and drag-to-connect both persist (`onConnect`). `edgesAfterConnect` keeps exec fan-in/fan-out and data fan-out, and **replaces** any existing wire on a data input. A pin drag into the empty-canvas zone (outside a 96px screen-space safe zone around the source pin and compatible opposite pins, and not over a node) shows a **Tap to Cancel** badge. **Releasing** in that zone opens Add Node; a pick places the node at the **wire-end flow position** from the drag pointer at release (`screenToFlowPosition`, same conversion as Behaviour Tree release add-node). A **second pointer** while the drag is held ends the rubber-band and does **not** open Add Node; lifting the drag finger after that cancel must not open the catalog. With **Context Sensitive** on, that menu is pin-filtered and auto-wires with the same replace rule; with it off, the menu is the host-legal catalog. Releasing without a snapped handle and without opening Add Node removes every edge on the dragged pin, unless the pointer is still over the source handle (tap-to-connect) or still in the Add Node zone (release opens Add Node instead of breaking). Palette uses the shared Dialog catalog shell (`@babylonslate/ui` Dialog + ScrollArea) with a role-color chip per item.
- **Hold empty pane ~250ms then move** marquees (`attachGraphPaneMarquee` overlay in wrapper-relative screen pixels from pointer or `touches[0]` client points; one-finger pan until the hold arms, then mouse/touch pan is swallowed and `panOnDrag` is off). Overlay **Break Links** drops every incident wire on the selection (nodes stay). Overlay **Format** walks each selected chain root independently (`graph-format.ts`): exec then-chain stays a horizontal highway; stacked exec successors sit a node-height apart; data/pure trees hang below-left of their consumer (not on the exec row). A selected pure node walks data-out down-right. Unconnected parents do not merge onto the first path; overlapping boxes are pushed apart.
- Pin and wire colors use `--pin-*` tokens (exec white, bool red, float green, string magenta, vector yellow, …). Exec wires are 5px, data wires 4px. Unbound wildcards use `--pin-wildcard`; once a type is wired in, resolving groups and boxed display types paint with the concrete token. The canvas forces XYFlow `colorMode="dark"` (chrome theme does not wash the graph) and `--xy-*` overrides in `graph-editor.css`.
- Canvas zoom: `GRAPH_MIN_ZOOM` 0.1 / `GRAPH_MAX_ZOOM` 1.5 (wheel, pinch, and Controls zoom buttons). Double-click / double-tap does not zoom (`GRAPH_ZOOM_ON_DOUBLE_CLICK` / XYFlow `zoomOnDoubleClick={false}`) so empty-pane double-tap can open Add Node. Opening `fitView`, Controls fit-view, and focused-node fit (Class Events / diagnostics) all cap at Engine Settings `graphDefaultZoom` (default 0.5). `fitView` on a large graph may pull back to 10%.
- Blocking Preview dialog uses `AlertDialog` (editor host).

Reusable by shader / animation / BT graphs later: keep graph-kind plugins (node types, validation binder) injectable; do not hardcode scripting-only assumptions into the canvas host.

### Pin defaults (Inspector + canvas)

Unconnected data inputs can store a literal used at compile time when no wire is present. `pinExpr` order: connected wire → stored `default:${pin.id}` / `default:${pin.name}` → live catalog `GraphPin.defaultValue` (`registry.get(typeId).pins(properties)`) → `defaultValueLiteral(type)`. Catalog fallbacks repair existing Print graphs that never stored Duration / Color. `listUnconnectedLiteralPinDefaults` uses the same catalog values so Duration shows `2` and Color shows white on a freshly placed Print. The Inspector edits `default:${name}` so pin defaults do not collide with node properties (`severity`, `body`, `count`, …). `ctx.input` / `ctx.output` resolve a pin by **id** first, then display name, so Title Case labels can differ from codegen keys. Connected pins hide the default field. `pin()` accepts an optional last `defaultValue`.

The graph canvas shows the same value as a **read-only** preview on the node (`PinDefaultPreviewWidget`): handle → preview → name. Bool is a decorative checkbox and color is a swatch (`size-5`); other literal kinds use a `text-base` / `h-8` truncated field (`max-width: var(--graph-pin-default-max-width)`). Previews are not focusable and do not change the graph — Inspector remains the editor. Wiring the pin hides the preview.

| Editable | Not in v1 |
| --- | --- |
| `bool`, `int`, `float`, `string`, `vec2`, `vec3`, `vec4` (XYZW scrubs), `rotator`, `quat` (XYZW), `color` (RGB; preserve `w`), `enumRef` (member-name Select from open Enum documents / registry **and built-in engine enums** such as `engine:CollisionChannel`; `collectEnumMemberNames` merges those members), `classRef` (`ClassPicker` filtered to subclasses of the pin’s `classId`; default is that constraint id), `assetRef` (`AssetPicker` with `allowedTypes` from `assetType`; default is a guid string), `structRef` (nested field rows from the Structure schema; changing the bound asset resets the object; later field add/remove hydrates missing keys and drops unknown keys) | `exec`, `objectRef` / `actorRef` (live instances — no Inspector default; implicit-self Target on Call is the exception), delegate, wildcards, `array`, `map`, opaque `transform` literals (use **Make Transform**) |

Authored defaults on types that **accept** literals clear `pin.missing_input`. A stored default on an object/actor **instance** pin is `pin.invalid_default`; the compiler ignores it and emits `null`. Boxed-wildcard node values (Print, Set Blackboard) still compile. Spawn Actor / Add Component `classId` pins are `classRef("Actor")` / `classRef("ActorComponent")`. Both expose an optional `Transform` pin (`transform`, unconnected → identity at the caller). **Attach Actor** / **Detach Actor** / **Get Parent** / **Set Owner** / **Get Owner** (`actor.attach`, `actor.detach`, `actor.getParent`, `actor.setOwner`, `actor.getOwner`) parent or own live actors; they do not copy transforms.

### Validation UX (`p5-graph-validation`)

- Debounced edit-time pass → Compiler Results + inline node/pin markers. Compiler Results list is windowed (`p20-log-virtualize`).
- Canvas connections use `scriptPinCompatibility` (`isAssignable` + class hierarchy), not kind-only matching. Wires persist **output→input**; an input-first drag is swapped on connect, and a reverse duplicate of the same pin pair is dropped. Host `normalizeConnection` (Animation Graph handle migration) still runs after that orientation, including when stacked same-side in/out plates would otherwise look same-direction. Validation canonicalizes a stored input→output pair the same way, so it does not emit `pin.direction` (same-direction pins still error).
- Missing required object/actor inputs, extra data wires on one input, stale Get/Set/Validated Get/Call members, unknown class ids, and local-vs-class variable name collisions emit errors (`pin.missing_input`, `pin.duplicate_connection`, `member.missing_*`, `member.unknown_class`, `member.local_name_conflict`). An inherited event whose parent no longer declares it is `event.missing_inherited`. An event or Get/Set component-ref bound to a component id that is not on the merged prefab list is `event.missing_component` (not `member.missing_variable`). Leftover actor-level Hit / Overlap / mouse / On Text Changed nodes without `componentId` bind when exactly one matching component exists; zero or many matching components emit `event.missing_component` rather than guessing. Unbound Structure/Enum pickers emit `type.unbound_struct` / `type.unbound_enum`; a guid missing from the project/open-doc/engine registry is `ref.unknown_guid`. Differing struct/enum guids stay `type.mismatch`. Interface methods that a class declares but does not implement emit `interface.unimplemented`. Pin arity/type drift vs the ScriptInterface or parent function emits `interface.signature_mismatch` / `member.override_signature`. Interface implementation Output data pins without a wire or authored default are errors (`pin.missing_input`) when that Output is on the compiled exec chain from Input. Exec pins may have several incoming wires; extra data inputs are errors (the canvas replaces on connect).
- Node-scoped diagnostics run only on nodes the compiler would emit (`compiledNodeIds`: trigger entries such as `flow.event.*` / `flow.entry` / function Input, exec-reachable successors including both Branch arms, Validated Get **Is Valid** / **Not Valid**, and Sequence `then_*`, and data-only pures those nodes read — Cast `success` / `result` when a compiled consumer uses them). Leftover isolated nodes and exec islands that never root at a trigger do not appear in Compiler Results and do not block Play. Edges into a compiled node still report (`type.mismatch`, `pin.direction`); `exec.cycle` / `pure.cycle` report only when the cycle includes a compiled node. `pure.cycle` is a cycle in the **pure evaluation** graph (`registry.pure` sources only — same rule as codegen `pinExpr`); impure data outputs are cached slots, so Line Trace location feeding back through Make Vector into End is legal. Graph-level rules (interface unimplemented, local name conflicts, extra/BT rules) still run.
- Content Browser compile-error overlay (same iconography as missing ref).
- Play button error-count badge.
- Global toolbar **Compilation Error** status next to Compile on graph documents (tap opens Compiler Results).
- Pre-Preview project sweep → blocking dialog with Play Anyway.
- Headless CI over golden fixture projects (`packages/scripting/fixtures/` — one broken graph per diagnostic code).

### Type assets (`p5-types`)

| Asset | Editor | Feeds |
| --- | --- | --- |
| Enum | Row editor | `enumRef` pin types; Make / Equal / Switch; variable and pin Defaults. Built-in engine enums (`engine:CollisionChannel` All / WorldStatic / WorldDynamic / Pawn / Visibility) are **not** Content Browser assets; Inspector Select still lists their members. |
| Structure | Field editor (`PinTypePicker`, nested Struct/Enum `AssetPicker`, typed field defaults; `StructField.typeClassId` stores a nested guid) | `structRef` pin types; Make / Break; variable and pin Defaults |
| Engine registry | `ENGINE_ENUMS` / `ENGINE_STRUCTS` in `@babylonslate/scripting` (`engine:` ids, no Content Browser file; `engine:CollisionChannel`, `engine:HitResult` live here) | Same Make/Break / picker paths as project assets. Engine **pin kinds** (`transform`, `rotator`, `quat`, `color`, `vec2/3/4`) stay first-class types, not fake Structure assets. |
| ScriptInterface | Signature editor (parameter-list editor) | Interface call nodes + class "implements" |
| FunctionLibrary | Class inheriting FunctionLibrary (EditorFunctionLibrary is a child base) | Static Call Function rows from open FL docs and `header.payload.functions`; EFL calls only on editor hosts |

## Runtime binding

Compiled class graphs bind to object-model lifecycle without changing dispatch shape:

- `BObject` / `Actor` / `GameInstance` event graphs → handlers invoked from existing `onCreation` / `onTick` / `onDestroyed`
- ScriptInterface method graphs (function members with `implementsInterface`) → `ScriptBundleEntry.interfaceImplementations` bound onto `interfaceHandlers`; `dispatchInterface` merges handler results with pin defaults
- FunctionLibrary → module of static functions; palette injects Call Function rows (open docs + header index). EditorFunctionLibrary is editor-only.

Play path: compile project graphs → worker `loadScripts` control message → `loadCompiledModule` → `registerAnchors` → spawn scripted actors → tick.

`shouldSpawnScriptedActor` skips `GameInstance`, `FunctionLibrary`, `EditorUtilityObject`, `EditorFunctionLibrary`, and `SceneLayer` so those graphs never auto-spawn as Actors. `spawnActor` also returns null for `SceneLayerActor` and subclasses — overlay actors come from SceneLayer documents / Create Scene Layer, not the world Spawn Actor node.

### Actor component graph APIs

Engine classes expose an optional script catalog in `@babylonslate/object-model` (`ENGINE_CLASS_SCRIPT_APIS` / `engineScriptApiFor`): variables, functions, and events. Not every component has all three. A property, Call, or event is listed only when the inspector already serializes it **and** Play can apply it (`setVariableOn` → `refreshComponent`, or `callNativeComponentFunction`). Authoring-only fields (`playOnStart`, collider `shape` blobs, Skybox face slots, Text3D `depth`) stay off the catalog.

| Component | Variables | Functions | Events |
| --- | --- | --- | --- |
| `MeshComponent` | Mesh Kind, Mesh (`assetGuid`; picker `typeClassIds` Mesh **and** Model), Material | — | — |
| `SpriteComponent` | Sprite, Sorting Layer, Order In Layer | — | — |
| `TilemapComponent` | Tilemap, Sorting Layer, Order In Layer | — | — |
| `SkyboxComponent` | Size | — | — |
| `CameraComponent` | Field Of View, Orthographic Size, Projection Mode, Near Clip, Far Clip | Possess | — |
| `LightComponent` | Enabled, Color, Intensity, Kind, Range, Inner Angle, Outer Angle, Cast Shadows | — | — |
| `Text3DComponent` | Text, Size, Color, Font | Set Text | On Text Changed |
| `2DTextComponent` / `2DRichTextComponent` | shared text + Hit Test, Renderer, Outline, Outline Color, Alignment, Bold, Italic, Underline, Wrap Width | Set Text | On Text Changed |
| `AudioComponent` | Audio, Volume, Loop | Play, Stop | On Audio Finished |
| `ParticleComponent` | Particle System, Sorting Layer, Order In Layer | Play, Stop | — |
| `RigidBodyComponent` | Mass, Gravity Scale, Motion Type, Linear Damping, Angular Damping | Add Impulse | — |
| `ColliderComponent` | Is Trigger, Friction, Restitution, Layer, Mask, Render In Game | — | On Hit / Begin Overlap / End Overlap |
| `NavAgentComponent` | Radius, Height, Max Speed, Max Acceleration | Move To, Stop Movement | — |
| `2DAnchorComponent` | Anchor, Offset X, Offset Y | — | — |
| `2DButtonComponent` | Hit Test | — | mouse enter/leave/click/press |
| `2DTextureComponent` / `2DMaterialComponent` | asset guid + Hit Test | — | — |
| `2DPanelComponent` | Source, Texture, Material, margins, Hit Test | — | — |

**Ref-only** (Get component pin, no catalog knobs): `AnimationGraphComponent` (use `anim.actor.*` nodes), `BehaviourTreeComponent` (BT graphs own activate/tick), `NavMeshComponent`, `NavMeshBlockerComponent`, `BlockingVolumeComponent` (bake/place-only).

User `ActorComponent` Class custom events appear the same way when that class is attached. Scene-instance-only components (not on the Class prefab) do not get Class-graph variables.

Compiled Get/Set of catalog variables uses `ctx.getVariableFrom` / `ctx.setVariableOn` on the component instance (`propertyKey` such as `text`). Native functions codegen `ctx.callComponentFunction(target, runtime, args)` (`setText`, `playAudio`, `stopAudio`, `playParticles`, `stopParticles`, `possessCamera`, `addImpulse`, `moveTo`, `stopMovement`). Actor-level `camera.possess` / `physics.addImpulse` / `navigation.moveTo` / `particles.play` nodes stay. Component Calls are for dragging off **Get Camera** / **Get Rigid Body** / **Get Nav Agent** / **Get Particle**. Particle Play/Stop stamps `componentId`. `setVariableOn` is not store-only:

- Visual / illumination / 2D text: `emitMeshAssignment` (`assignMesh` / `assignMaterial`, including sprite/tilemap `sortingLayer` / `orderInLayer`).
- `ParticleComponent`: `assignParticle` (guid + sorting).
- `2DAnchorComponent`: `applyOverlayAnchor` (same path as frustum resize).
- `AudioComponent` Volume: `{ type: "setVoiceGain"; voiceId: component.guid }` for the live voice. Loop applies on the next Play.
- `RigidBodyComponent` / `ColliderComponent`: `PhysicsWorldSync.applyComponent` → `updateBody` / `updateCollider` (see [physics.md](physics.md)).
- `NavAgentComponent`: `updateAgent` on the live Recast crowd (radius / height / max speed / max acceleration).

`setVariableOn` / Set Text on a text component also fires `onTextChanged` for entries bound to that component id.

### Entry points

`Event Begin Play` (`flow.event.beginPlay`), `Event Tick` (`flow.event.tick`), and `Event On Actor Destroyed` (`flow.event.destroyed` → `onDestroyed`) are unscoped host entry nodes on Actors (no component qualifier). `Event Editor On Begin Play` (`flow.event.editorBeginPlay` → `onEditorBeginPlay`) is the editor-only entry on EditorUtilityObject (no Tick). **Event On Hit** / **On Begin Overlap** / **On End Overlap** are `ColliderComponent` events (`flow.event.hit` / `beginOverlap` / `endOverlap` → `onHit` / `onBeginOverlap` / `onEndOverlap`), one override per attached collider, titled `Event On Begin Overlap (Collider)`. Overlay pointer events (`flow.event.onMouseEnter` / `onMouseLeave` / `onClick` / `onPressStart` / `onPressEnd`) come from `2DButtonComponent` (overlay-exclusive), one override per button (`Event On Click (2D Button 2)`). **Event On Text Changed** (`flow.event.textChanged` → `onTextChanged`) is per text component. **Event On Audio Finished** (`flow.event.audioFinished` → `onAudioFinished`) is per `AudioComponent` (non-looping voices only; see [audio.md](audio.md)). New class graphs do **not** seed component events. Hit outputs Hit Result (`engine:HitResult`: Hit, Location, Normal, Actor, Distance), Other Actor, Location, and Normal. Overlap outputs Instigator (the other actor). Custom events (`flow.event.custom`) are also entries; the compiler names the export from the member (`On_Hit`). The compiler emits one exported function per entry node, named after its event, so a single graph module can export both `onBeginPlay` and `onTick`. Duplicate component-bound exports suffix (`onClick`, `onClick_2`). A graph whose only entry is `flow.entry` exports `run` and binds to nothing. `CompiledEntryPoint` may carry `componentId`; `ScriptHost.invokeEvent(..., componentId?)` runs host-wide entries when the invoke has no component id, and otherwise only the entry whose compiled id matches the live component guid or prefab `sourceId`. Leftover unbound Hit / Click / Overlap / Text Changed / Audio Finished entries do not run for every component. Play compile (`compileGraphDocument`) binds those leftover nodes when exactly one matching prefab component exists — the same rule as editor hydrate.

`RuntimeDriver` polls `PhysicsBackend.pollContacts()` after `step` and invokes those exports on both actors (swapped Other / flipped Normal), passing `colliderAId` / `colliderBId` mapped from `collider:${guid}`. Prefab **Actor Defaults** `generateHitEvents` / `generateOverlapEvents` (default on) copy onto spawned and scene-realized actors; a flag off skips script dispatch for that actor and kind while physics still simulates. Timeline collision tracks stay deferred. Overlay pointer dispatch keys hover/press by `actorGuid:componentId` so two buttons on one actor do not share hover.

`CompileResult.entryPoints` reports `{ name, event, nodeId, isAsync, componentId? }` per export. An entry point is async when it contains a latent node (`Delay`, async `ExecuteJavaScript`) **or a Call Function whose target Function is latent**. `ScriptHost` skips a latent entry point that is still pending so a per-tick event cannot stack one run per frame.

### `ScriptHost` (`@babylonslate/runtime`)

`ScriptHost.load(script)` loads a compiled module and `hooksFor(classId)` returns `LifecycleHooks` that run its entry points. `RuntimeDriver.loadScripts()` registers each bundle's class id into the world's `ClassRegistry` (`parentClassId`, `implementedInterfaces`, variable defaults), registers modules plus their anchors, and `spawnScriptedActor({ classId })` / scene instantiate apply those defaults. Throws inside a script become runtime diagnostics mapped back to the graph node through the anchor table. `InfiniteLoopError` uses code `runtime.infinite_loop` and aborts the rest of that tick (one shared budget for all actors).

The `ctx` handed to compiled code copies the world's `TickContext`: `self`, `deltaSeconds`, `formatValue`, `checkInfiniteLoop`, `log`, `print`, variable access (`getVariable` / `setVariable` on self; `getVariableFrom` / `setVariableOn` for a Target instance; `getComponentById` / `callComponentFunction` for prefab component refs and native ops such as Set Text / Play), transform writes, tick-clock `delay` (pause-safe, not `setTimeout`), interface dispatch via `dispatchInterface` (`guid:method` keys, pin defaults when the target does not implement the method; `callInterface` forwards an args object and returns handler results), input (`isActionHeld` / `wasActionPressed` / `wasActionReleased` / `getAxis` / `getAxis2D` / `getCursorPosition` / `projectCursorToScene` / `setCursorVisible` / `setGamepadRumble` / `gamepadConnections`), `addComponent`, `spawnActor`, `isA(instance, classId)` (`ClassRegistry` ancestry), `invokeCustomEvent(target, eventName, args)` (dispatches on `target.classId` with `self = target`; when `target` is an `ActorComponent`, also dispatches owner-actor entries bound to that component id), `invokeFunction(target, functionName, args)` (instance Calls look up `exports[functionName]` on `target.classId`; static FunctionLibrary Calls pass the library class id string, e.g. `ctx.invokeFunction("MathLib", "Add", …)`; returns the result object or `{}`, or a Promise of that object when the export is async — Call Function awaits only when the target Function is latent), `commandArgs` plus alias `args` (function Input nodes and custom event outputs), synchronous physics queries (`lineTrace`, `sphereOverlap`, `shapeSweep`, `addImpulse`), `changeScene` (loads a scene from the Play scene library, same as console `changescene`; swaps the **world** Scene only), SceneLayer compositor helpers (`createSceneLayer` / `removeSceneLayer` / `clearSceneLayers` / `registerSceneLayerPostProcess` / `unregisterSceneLayerPostProcess` — overlay stack, not additive world streaming; see [scene-layers.md](scene-layers.md)), `playSound` (emits a `playSound` command; Play logs it — there is no mixer yet), and `setRenderResolution(width, height)` (emits `setRenderResolution`; Play applies `setSize` for the session only). Missing helpers must fail validation or emit a command; they must not silently no-op.

`ScriptHost.invokeEvent(classId, event, self?, args?, componentId?)` (and `RuntimeDriver.invokeScriptEvent`) passes `args` into the compiled entry as `ctx.commandArgs` / `ctx.args`. When `componentId` is set, only entries whose compiled id matches that live guid or the component’s prefab `sourceId` run. Host invokes (no `componentId`) skip component-bound entries. Cross-instance Call uses the target actor’s class id, not the caller’s.

`RuntimeDriver` constructs the session `GameInstance` from `gameInstanceClass` (project picker, scene fallback), not a hardcoded `"GameInstance"` id, and binds compiled interface handlers onto spawned actors from class-declared interface guids (no hand-passed array required).

`compileGraphDocument` copies Class member variables (excluding function locals) and ScriptInterface `assetGuid`s onto `ScriptBundleEntry`, plus optional `parentClassId` from the asset header. Function compiles pass `localPreamble` (`let __lv_*`) into `compileGraph`.

### Codegen invariants

- Impure node output slots are declared once at the top of each entry point, never inside a branch body — a node reachable from two `Sequence` outputs or both `Branch` arms must not redeclare them, and downstream reads must stay in scope. Slot temps are named from the pin **id** (`_n_<node>_<id>`), not the Title Case display name, so writers (`ctx.output`) and pure readers stay on the same variable.
- Editor / debugger compiles (`compileGraphDocuments`, `instrumentInfiniteLoops: true`) prepend `ctx.checkInfiniteLoop();` to each impure exec emit and to generated `for` / `while` bodies (for example the gamepad connect loop). Play prepare / toolbar Compile reuse `GraphScriptCompileCache` (`p20-play-compile-audio`) so an unchanged graph is not recompiled. `graphCompileSignature` omits node positions on the **event graph and every function graph**; Class `members` (including variable defaults) stay in the key. Release `compileGraphDocumentsForExport` leaves the flag off — no checks in shipped JS. Call Function recursion shares the same per-tick budget.
- `ctx.checkInfiniteLoop` is always a function on `ScriptContext` (no-op when the debugger guard is missing or disabled) so mixed or stale instrumented scripts cannot throw `is not a function`.
- A node that emits `await` must call `ctx.requestAsync()` (or declare `latent: true`) so the entry point is emitted `async`.
- Statements must not introduce fixed-name temporaries; assign into `ctx.output(pin)` slots instead, since a node can be emitted more than once per function.

### Editor Play wiring

Play (`requestPlay`) saves dirty documents and compiles project graphs **before** the overlay launches. If anything still needs saving or compiling, a non-dismissible progress dialog (`play-prepare-dialog`) lists dirty names and the current phase (`Saving…` / `Compiling…`). A clean project with a current compile skips the dialog. After compile, blocking diagnostics open the existing Play Anyway dialog; Play Anyway launches with the bundles just produced and does not skip save/compile. Schema migrations abort prepare and reuse the migrate-on-save dialog; Play resumes after approval.

`collectPlayPreviewScripts()` (document context) loads every graph in `ProjectDocument.graphs` (open in-memory documents first, else disk) **plus** `compileAnimGraphScripts` for every AnimationGraph (`AnimGraph:{guid}` / `AnimRule:{guid}:{transitionId}`, `parentClassId: "BObject"`), validates that set, and compiles to `ScriptBundleEntry[]` through `GraphScriptCompileCache` so an unchanged graph is not recompiled (`p20-play-compile-audio`). `startPlaySession({ scripts })` ships them to the worker, or loads them into the in-process runtime when no worker is available. Class graphs still derive `classId` from the file stem (`main.class.babasset` → `main`). `shouldSpawnScriptedActor` skips `GameInstance` / `FunctionLibrary` / editor classes / `SceneLayer` so those graphs cannot create rogue Actors. Animation Graph scripts use the `AnimGraph:` / `AnimRule:` prefixes so they also do not spawn extra actors. See [anim-graph.md](anim-graph.md).

A `runtime.infinite_loop` diagnostic **stops Play immediately** (overlay and Preview Build) and opens the Preview session report with message **Infinite loop detected**. Other runtime throws still wait for Stop. See [debugger.md](debugger.md).

## Acceptance (phase)

An actor scripted in the editor compiles and runs in the worker; a type mismatch is flagged before Preview and tap-to-navigate focuses the pin; an ExecuteJavaScript node round-trips values through the graph; compiler golden tests cover IR→JS + anchors.

## Explicit non-goals / deferrals

| Item | Owner |
| --- | --- |
| Full physics / input node behaviour | Queries, impulse, and `physics.moveCharacter` done (P7) |
| ExecuteConsoleCommand registry + debug-tier warnings | P8 (`p8-command-system` landed) |
| BDebugCommand / OnCommandRun / Play console + trace | P8 (landed) |
| Keyed Print HUD polish | Landed (shared `print-hud` + packed-player overlay; Print String / Draw Debug) |
| Behaviour-tree validation rules | P11 |
| Shader / AnimationGraph validators | P9 |
| Scene viewport Play badge on 3D viewport | P6 scene chrome (wire badge API in P5; host may be class-doc Play until then) |
| Possess Camera / Default Camera pick | Done (`p-lighting-camera`, [engineplan §2.5](../engineplan.md)) |

## Implementation order

See [issue-tracker P5 slice ownership](../agents/issue-tracker.md#p5-slice-ownership). Summary:

1. **Design notes** (this doc) + ESLint / workspace stubs.
2. **`p5-scripting-core`** — IR, types, validator hook, compiler + goldens (**API before catalog**).
3. **`p5-wildcard`** + `formatValue` — can land with or immediately after core.
4. **`p5-node-catalog`** — parallel agents per category against the stable registry API.
5. **`p5-execute-js`** / **`p5-log-print`** — special nodes + editor-kit parameter list / CodeMirror.
6. **`p5-graph-ui`** + **`p5-types`** — parallel once IR serialisation is stable.
7. **`p5-graph-validation`** — editor gates and CI fixtures last, consuming Compiler Results from graph-ui.

## Implementation status (landed)

Packages `@babylonslate/scripting` and `@babylonslate/scripting-nodes` are in-tree. Editor wires validation (Compiler Results, Play badge + Play Anyway `AlertDialog`), graph-ui tap-to-connect **and** drag-to-connect + CatalogDialog palette (**Context Sensitive**, host-legal catalog), Class panel, CodeMirror ExecuteJavaScript body editor, Enum/Structure/ScriptInterface creatable assets, `FunctionLibrary` / `EditorFunctionLibrary` engine bases with static Call Function rows, `formatValue`, and validator fixtures.

Preview runs compiled graphs: `ScriptHost` binds Begin Play / Tick entry points to actor hooks, copies tick input into `ctx`, `Print` reaches the on-screen overlay, and `e2e/p5-scripting.spec.ts` covers Tick→Print plus Tick→GetAxis2D (injected gamepad). Play with no scene tab is disabled. **Possess Camera** (`camera.possess`) emits `{ type: "possessCamera"; slotId }` for the global Play `activeCamera`. Camera/light property nodes mutate component variables and re-emit `assignMesh`. **Cast** uses `ctx.isA` backed by the session `ClassRegistry` (Actor, ActorComponent, GameInstance, editor objects — ancestry, not string equality).

**Follow-ups (non-blocking polish):** tracked as a table under [issue-tracker P5 follow-ups](../agents/issue-tracker.md#p5-follow-ups--open-deferrals). **Development Only** (Inspector flag, catalog `developmentOnlyByDefault` on Print / Print String / Draw Debug, `compileGraphDocumentsForExport`) is landed — do not reopen Print-strip as a P5 gap. Pin hydration, palette pins, Begin Play/Tick defaults, AddNode undo persistence, **drag-to-connect**, **Format**, **hold-to-marquee**, **class-owned graphs**, and **Enum / Structure / ScriptInterface DockView editors** are landed.

- Blob-URL dynamic import in WKWebView — spike early; fallback already in `loadCompiledModule`.
- Re-parenting class invalidation — design Class panel UX against `ClassRegistry.reparent` from the start.
- Blocking Preview dialog becoming dismiss-reflex — Play Anyway + "don't ask again"; demote noisy rules rather than harden the dialog.
- ExecuteJavaScript unsandboxed — disclose on import when assets contain JS bodies.
- Anchor tables invalidated by code moves — rewrite offsets on concat; never minify.
