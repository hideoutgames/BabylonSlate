# Visual scripting (P5)

Shared surface for graph IR, pin types, validation, and JS codegen (engineplan §6, §6.1–6.2, §9.7 anchors, checklist `p5-*`). New packages: `@babylonslate/scripting`, `@babylonslate/scripting-nodes`. Editor shell: `@babylonslate/graph-ui` + class / type asset panels in `apps/editor`.

P4 already owns stack→node mapping (`AnchorEntry`, `loadCompiledModule`, Preview session report). P5 fills the compiler that emits those anchors and the editor that navigates to them. ExecuteJavaScript hoist lines carry `bodyLine` so a runtime throw inside the user body maps to the CodeMirror line; tapping a session-report row opens the owning Class (or BehaviourTree) asset if needed. `Log` at Error severity is a session-report row (`runtime.log`), not only Output Log.

## Package boundaries

| Package | Owns | Must not import |
| --- | --- | --- |
| `scripting` | Graph IR, pin type system, type context, pure validator + rule hook, deterministic JS codegen + anchor table | React, Babylon, Capacitor |
| `scripting-nodes` | Data-driven node catalog (id, title, category, pins, codegen) | React, Babylon, Capacitor |
| `graph-ui` | Touch React Flow shell reusable by script / shader / anim / BT graphs; Blueprint node chrome; pin/wire colors via `--pin-*` tokens | Babylon, Capacitor |
| `core` | Shared `formatValue`, diagnostic / pin type primitives reused outside scripting | React, Babylon, Capacitor |
| `runtime` | Loads compiled modules, registers anchors, Log/Print command forwarding | Babylon, DOM |
| `apps/editor` | Class document, Class panel, Compiler Results, validation gates, type asset editors | Capacitor |

Add `scripting` / `scripting-nodes` to the ESLint pure-package allowlist beside `object-model` (same React/Babylon/Capacitor bans).

`scripting-nodes` depends on `scripting` (types + codegen helpers). `scripting` must not depend on `scripting-nodes` — the compiler takes a **node registry** injected at compile time so catalog categories stay independently testable. `scripting` may import `instrumentJsLoops` from `@babylonslate/debugger`; debugger does not import scripting.

## Graph IR

Replace today's placeholder `SerializedGraph` (untyped nodes + edges without pin ends) with a typed IR stored on the **Class** asset payload (every class parent: `BObject`, `Actor`, `ActorComponent`, `GameInstance`, `FunctionLibrary`, `EditorFunctionLibrary`, `BDebugCommand`, `EditorUtilityObject`, `BTTask`, `BTDecorator`, `BTService`, `BTComposite`). New files use `.class.babasset`. Legacy `type: "Graph"` / `.graph.babasset` still loads and rewrites to Class on save. **UserInterface** is not a Class: chrome **Designer | Logic** mode bar, then Class docks on `payload.logic` (authoring `parentClass` defaults to BObject; compile stamps `classId` `UserInterface:<guid>` / `parentClassId` `UserInterface`). Prefab + Components dock tabs appear only when Class ancestry includes **Actor**; other classes get Graph, Class, Inspector, and Compiler Results. **EditorUtilityObject** native events are **Event Editor On Begin Play** plus On Editor Startup / On Scene Open / On Scene Saved / On Editor Shutdown (not game Begin Play / Tick). Boot order is construct → Editor On Begin Play → On Editor Startup → optional On Scene Open. They run in the in-process editor ScriptHost when listed in Project Settings — see [editor-extensions.md](editor-extensions.md). **EditorFunctionLibrary** is an engine base (parent FunctionLibrary) offered in New Class; EFL Call Function rows appear only on editor graph hosts.

```ts
type PinKind = "exec" | "data";
type GraphPin = {
  id: string;
  name: string;
  kind: PinKind;
  direction: "in" | "out";
  type: PinType; // see types
  optional?: boolean;
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
| Pre-Preview | Project graphs compiled for Play (`collectPlayPreviewScripts`), including Class/Graph documents, UserInterface `payload.logic`, and AnimationGraph Animation Object / transition-rule scripts; Play loads the **open scene tab** and the project `gameInstanceClass` (`resolveGameInstanceClass`, scene field is fallback). No scene tab → Play disabled. Enabled plugin Class graphs participate via `registry.list()`; plugin EUOs stay on the editor ScriptHost ([plugins.md](plugins.md)) |
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
| Development Only | `properties.developmentOnly`; Print defaults on. Canvas nodes draw a Unreal-style yellow/black hazard-tape footer. Editor Play keeps the node. Export `compileGraphDocumentsForExport` (`stripDevelopmentOnly: true`) skips codegen and continues exec at `then`, or Sequence `then_*` pins in order (skip as no-op). Exclusive Branch `true`/`false` arms are not entered. Data pins from a stripped node compile as type defaults. A flagged event entry is omitted from the export module. |
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
| **Print** | Boxed wildcard via `formatValue`; colour + duration; keyed registry replaces in place; worker sends command, HUD draws; **Development Only** by default (Inspector checkbox; canvas hazard-tape footer; export compile skips the node) |
| **ExecuteConsoleCommand** | Runs through `@babylonslate/debugger` command registry; returns success + output; compile-time warning when a literal names a debug-tier command |
| **Event On Command Run** | `BDebugCommand` entry; output pins from the parameter list; compiles to `onCommandRun` |
| **Custom Event** | Class Events `flow.event.custom`: Then plus data **outputs** from member `pins[]`; outputs read `ctx.commandArgs` |
| **Call Custom Event** | `flow.event.call`: same-class / inherited Calls omit Target (`implicitSelf`, `ctx.self`); other-class Calls require Target. Data **inputs** + Then. Display title is `Call <Name>` (not Event-prefixed). Codegen `ctx.invokeCustomEvent`. Hidden as a generic catalog id; palette injects one row per event. Call nodes are not Class Events members (`flow.event.call` and `flow.event.callParent` skipped in the Events tree) |
| **Call Parent Event** | `flow.event.callParent`: title `Call <Event> Parent`. Exec in/out plus data **in and out** matching the event’s outputs (passthrough after parent runs). Codegen `ctx.invokeEvent(parentClassId, exportName, args)`. Hidden generic catalog id. Brown title bar (`--node-call-parent`). Seeded on new Class graphs (and when placing a missing Event stub) wired from Event Then; user may delete or move later without re-seeding on hydrate |
| **Call Function** | `functions.call`: same injection for class-owned functions (local + inherited + other open Classes). Same-class Calls omit Target; other-class Calls require Target. Signature data ins/outs. Codegen `ctx.invokeFunction`. Generic catalog **Call** is hidden. **FunctionLibrary / EditorFunctionLibrary** inject static Call Function rows (`implicitSelf` + `static`, no Target pin) from open FL documents **and** the header signature index (`header.payload.functions` via `functionLibraryHeaderMeta` on save). Codegen `ctx.invokeFunction("MathLib", "Add", …)`. EFL rows only on editor hosts (`isEditorGraphHost`). |
| **Call I `<Method>`** | `interface.call`: generic catalog id hidden. Palette injects one row per ScriptInterface method (`Call I Apply Damage`). Target `objectRef(BObject)` (unconnected uses `ctx.self`). Signature pins from the method; guid/method live in node data. Codegen `ctx.callInterface(target, guid, method, args)`. Legacy guid/method string pins still compile. |
| **Get Variable** | Bound `variables.get`: typed data **out** named after the variable (`id` stays `value`); Target only when `implicitSelf !== true`. Palette injects `variables.get:Class:Name` per class / inherited / other-open-Class member. Function locals appear only while that function graph is open. Generic catalog id is hidden. Self codegen `ctx.getVariable`; Target `ctx.getVariableFrom`; locals read `__lv_Name` |
| **Set Variable** | Bound `variables.set`: exec / then, typed value in + pass-through out **named after the variable** (`id`s stay `value` / `out`); same Target and palette rules (`variables.set:Class:Name`). Self `ctx.setVariable`; Target `ctx.setVariableOn`; locals assign `__lv_Name`. Pass-through writes the Set output slot |
| **Cast to `<Class>`** | Dynamic `casting.cast`: live-object in (`objectRef(BObject)`), Class in (`classRef(BObject)` with a literal default), Success bool, Result out. Unconnected Class titles the node `Cast to Hero` and types Result as `actorRef` when the default class is Actor ancestry, otherwise `objectRef`. A wired Class pin titles it `Cast to Class` and types Result from the connected constraint (or `BObject`). Generic catalog ids `casting.cast` / `casting.castActor` are hidden; Add Node injects one searchable row per known engine/project class. Codegen `ctx.isA(instance, classId)` via `ClassRegistry.isA`. Old `casting.castActor` graphs still load. |
| **Report Command** | Sets the console success flag + output string for `OnCommandRun` |

Shared **PinListEditor** / **PinTypePicker** in `editor-kit` author typed named reorderable pins (color chip, compact type picker, up/down, trash icon, Class Type on object/class pins). `ParameterListEditor` is a thin wrapper for ExecuteJavaScript Inputs/Outputs and `BDebugCommand` / Event On Command Run. Class function signatures and ScriptInterface method pins use `PinListEditor` directly.

## Node catalog (`scripting-nodes`)

One module + one test file per category:

`flow`, `math`, `vector`, `string`, `array`/`map` (`array.*` plus `map.get` / `map.set` / `map.has` / `map.remove` / `map.size` / `map.keys` with K/V wildcards), `actor`, `component`, `transform`, `physics` (LineTrace, Sphere Overlap, Shape Sweep, Add Impulse — sync on calling exec pin), `input`, `audio` (Play Sound, Set Channel Volume, Set Global Volume), `ui` (**Apply User Interface** `classRef` → `objectRef`; **Remove User Interface** / **Set Widget Visibility** take object refs; generic **Get Widget** is hidden — palette injects `Get <Name>` per document widget as `objectRef(ButtonWidget)` / …), `scene`, `camera` / `light` (Possess Camera, get/set FOV and orthographic size, set light enabled/color/intensity), `debug`, `interface`, `variables` (bound Get/Set; generic catalog ids hidden — palette injects per class member and per open-function local), `casting` (`Cast to <Class>` rows injected per known class; generic `casting.cast` / `casting.castActor` hidden), `timers`, `functions` (Call Function; generic catalog id hidden — palette injects per class member), `behaviour-tree` (On Activate / On Tick / On Abort / On Evaluate / Finish Execute / Return Condition / Get Blackboard / Set Blackboard), `navigation` (FindPathTo, MoveTo, StopMovement, path queries, obstacle add/remove).

Each node: `{ id, title, category, pins, codegen(ctx) }`. Physics/input nodes may register with compile-time "not yet available" or emit TODOs that fail validation until those phases — prefer stub codegen that throws a clear diagnostic over silently no-op.

AI / navigation categories: behaviour-tree event/finish/return/blackboard nodes plus `navigation.*` (FindPathTo, MoveTo, StopMovement, path queries, obstacle add/remove). `scripting-nodes` emits `ctx.*` only — Recast stays in `@babylonslate/navigation` / runtime. **Return Condition** (`bt.returnCondition`) is exec in + bool in → `ctx.btEvaluate(bool)` (On Evaluate has exec-out only). **Get/Set Blackboard** (`bt.blackboard.get` / `bt.blackboard.set`) mirror variable nodes onto `ctx.getBlackboard` / `ctx.setBlackboard`. Class Add Node palettes filter by parent ancestry: Actor graphs hide `bt.event.*` / finish / return / blackboard; `BTTask` gets activate/tick/abort + finish + blackboard; `BTDecorator` gets evaluate + return + blackboard; `BTService` gets tick + blackboard; `BTComposite` hides Actor and BT leaf events.

**Audio** (`audio.play` / `audio.setChannelVolume` / `audio.setGlobalVolume`) lives on Class and Actor palettes. Play Sound takes an `assetRef("Audio")` pin and Volume default `1`, and emits `playSound` with `self` as emitter. Set Channel / Set Global clamp `0..1` and replace session mixer values (warned no-op without a selected mixer / unknown channel). Inspector maps `assetRef` pins to `AssetPicker` with `allowedTypes`. See [audio.md](audio.md).

### Editor-only graphs

`NodeDefinition.editorOnly` marks real editor-only catalog nodes (editor lifecycle events). Helpers `isEditorGraphHost` / `isEditorGraphClass` / `isEditorFunctionLibraryClass` live in `packages/core/src/editor-only.ts`. Runtime graphs never see EditorUtilityObject / EditorUtilityInterface / EditorFunctionLibrary **or their functions**, even with Context Sensitive off. See [editor-extensions.md](editor-extensions.md).

## Editor surfaces

### Class document

- **Graph** canvas (event + per-function graphs). **Double-tap empty pane**, empty-pane right-click / long-press, and the toolbar **+** (`graph-add-node`) open Add Node (`Dialog` with categories + search; search is **not** autofocused). Default menu is all **host-legal** nodes (not the whole engine catalog). Footer **Context Sensitive** (`data-testid="node-palette-context-sensitive"`, default ON): pin-drag / pin filter applies only when on. Search and category reset every time the dialog opens. Category counts (including All) follow the search-filtered set. Drag-to-connect and tap-to-connect both persist. Exec pins accept multiple wires in and out; a second data wire onto the same input **replaces** the previous. Pin-drag Add Node uses a 96px screen-space safe zone around the source pin and compatible pins; a live **Tap to Cancel** hint follows the wire in that zone. **Releasing** in that zone opens Add Node; a **second pointer** while the drag is held cancels the rubber-band and does not open the catalog. The pick spawns at the wire-end flow position (`screenToFlowPosition` of the drag pointer) and auto-wires. A cancelled pin drag (no snap, no Add Node, pointer left the source handle) breaks every wire on that pin. Pin visuals are hollow until connected (`data-pin-connected="false"|"true"`).
- **Class**: My Blueprint member tree (Functions, Variables, Events, Interfaces — empty sections stay visible; no Graphs section) stacked *under* Components, about 50% of the left stack. **FunctionLibrary / EditorFunctionLibrary** show Functions + Local Variables (when a function graph is open) only — no events, member variables, or interfaces. Empty event graph has no native events; empty state tells the user to add a function. Each section row has a trailing **+** (`IconActionButton`); Functions **+** opens **Add Function** (`AddFunctionDialog`: **New Empty Function**, then a scrollable list of overridable parent functions and ScriptInterface methods — overwritten rows are muted). There is no toolbar Add dropdown or trash. Delete is the row context menu only. Rows use `TypeColorMark`. Writes `SerializedGraph.members` (variables: `typeId` + optional `typeClassId` for object/class refs + optional `defaultValue`; function locals: same kind with `functionId` pointing at the owning function member; functions: `pins[]` plus `functionGraphs[id]`, optional `overridable` (default off), optional `implementsInterface` / `overrides`; interfaces: ScriptInterface `assetGuid`; custom events: data `pins[]` mirrored onto the event node). Event names are Title Cased (`On Hit`; node title `Event On Hit`). Custom events insert `flow.event.custom` (Then plus data **outputs**). **Call Custom Event** (`flow.event.call`), **Call Function** (`functions.call`), and bound **Get/Set Variable** (`variables.get` / `variables.set`) are injected into Add Node — one row per local/inherited member (`implicitSelf`, no Target pin) and per other open Class member (required Target). Generic catalog ids are hidden. **Drag a Class-panel row onto the graph** (pointer capture, not HTML5 DnD): custom events spawn Call Custom Event, functions spawn Call Function, variables/locals open a Get/Set `Dialog` then spawn at the drop; a floating drop hint shows `+` / ban while dragging. Call nodes are not Class members (`flow.event.call` and `flow.event.callParent` are skipped in the Events tree; functions already come from `members[]`). New function graphs seed protected Input/Output with Input Then wired to Output Exec on create (deleting the wire sticks — no hydrate re-seed). Call Custom Event has Then plus matching data **inputs**; Call Function also maps signature data **outputs**. FL/EFL also inject static Call Function rows from open FL docs and `header.payload.functions` (`functionLibraryHeaderMeta` on save): `implicitSelf` + `static`, no Target; codegen `ctx.invokeFunction("MathLib", "Add", …)`; EFL only on editor hosts. **Native events** follow parent ancestry: Actor graphs list Begin Play and Tick (plus On Command Run when ancestry includes `BDebugCommand`); `BObject` / `GameInstance` / `ActorComponent` list none of those; `EditorUtilityObject` lists On Editor Startup / On Scene Open / On Scene Saved / On Editor Shutdown; `FunctionLibrary` / `EditorFunctionLibrary` list none; `BTTask` lists On Activate / On Tick / On Abort; `BTDecorator` lists On Evaluate; `BTService` lists On Tick; `BTComposite` lists none of those. Clicking a missing stub spawns the node on the event graph, then focuses it. Parent Class custom events, variables, functions, and interfaces are listed as inherited with a tiny **Inherited** badge (read-only; activate opens the declaring Class when it is not an engine-locked id). Call Custom Event titles stay `Call <Name>` (never `Event Call …`); event Output edits sync onto the event node and matching Call inputs. **Local Variables** (trailing **+** `class-add-local-variables`) lists members with that function’s `functionId` and is hidden on the event graph. Selecting a variable or interface does **not** leave the open function graph; events still switch to the event graph. Variable row context menu **Get** / **Set** spawn bound nodes into the current slice. Rename/type on a variable syncs matching Get/Set nodes on the event graph and every `functionGraphs` slice. Selecting a function switches the Graph dock to that function’s Input/Output graph (`activeFunctionId`). `diffGraphCommands` emits `graph.setFunctionGraphs` so those slices survive undo. `flow.event.custom` compiles to a named export (`On_Hit` from "On Hit"); Call Custom Event codegen is `ctx.invokeCustomEvent(target, eventName, args)`. Function graphs compile to a named export from the member name; Call Function codegen is `ctx.invokeFunction(target, exportName, args)` (lookup by export name, not `point.event`); static FL calls pass the library class id as the first argument. Function locals compile as `let __lv_Name = <default>;` at the start of that export only (not `ScriptBundleEntry.variables`). Play dispatches custom events with `ScriptHost.invokeEvent(classId, event, self, args)`. Function Output nodes `return { pin: ctx.input(pin), … }` so Call can assign data outputs.
- **Details** (dock title Inspector): canvas selection drives the target (first selected node; Compiler Results / Play focus as fallback). A selected Class member shows variable type (`PinTypePicker`) and a typed Default row (`PropertyGrid`: bool/number/text/vector; changing type resets the default). Object Reference variables show **Class Type** only (`ClassPicker`); Class variables show **Class Type** plus an actual Default class. Closed Class Type / Default / Script Interface buttons use `PickerIdentity` (icon, name, type — **Class** or **ScriptInterface**). Function **Inputs** and **Outputs** (`PinListEditor` with exec plus data types, trash-icon remove, Class Type on object/class pins) plus **Overridable** (default off). Interface implementations show **Interface Implementation**, lock Name/Inputs/Outputs, and omit Overridable. Interface `AssetPicker` for interface members. Selecting a Class-panel custom event focuses the canvas node; Details shows **Outputs** (`PinListEditor`, data types only — exec Then is implicit) and syncs pins onto matching Call nodes. Function signature edits also sync matching `functions.call` nodes. Empty selection shows an empty state — no ExecuteJavaScript fallback. Unconnected applicable data pins get literal defaults (`classRef` uses `ClassPicker` filtered to subclasses; the PropertyGrid trigger matches the modal row); ExecuteJavaScript still has pin lists + body; Log has severity / category; every selected node has **Development Only** (Inspector flag). **Editor Only** is catalog-stamped (`NodeDefinition.editorOnly` → `data.__editorOnly`), not an Inspector checkbox.
- **Compiler Results**: diagnostics grouped by graph; tap → select node, pan canvas, flash pin (or scroll CodeMirror to `bodyLine`).
- **Prefab** (Actor): full-size center tab; 3D preview + gizmos; per-component pick/gizmo; Prefab Root origin **is** the Scene actor origin. Component tree writes `SerializedGraph.components` including local `transform` (undo via `graph.setComponents`). Parent Class components merge in (Inherited badge; editable details/transform; not removable). Place Actors copies the merged list onto spawned Class actors when the class document is open.
- **Components**: nested actor component tree (`parentId`) in the left dock; immediate drag-to-parent; Add Component uses the Place Actors catalog chrome. Multi-select matches Outliner (Ctrl/Shift/Meta, swipe add, two-finger range; additive Prefab Root is exclusive). Inspector **N Components** when more than one component is selected. Inherited rows cannot be deleted; Remove deletes every selected local component (and descendants).

### Type assets (Enum / Structure / ScriptInterface)

These open their own DockView documents (not compact Settings tabs). **Windows** lists their panels.

| Kind | Default panels |
| --- | --- |
| Enum | Members table (name + value) + Details |
| Structure | Member list with pin colors + Details (`PinTypePicker`, default) |
| ScriptInterface | Methods \| read-only function-node Preview (`GraphEditor` `readOnly`) \| pin Details (`PinListEditor` in/out) |

Texture / Material / Model / Audio / Animation stay compact `asset-settings`. Sprite opens a DockView document (Preview + Details). FunctionLibrary remains a Class parent, not a file type.

### `graph-ui` rework

Touch-first React Flow 12 shell (`@babylonslate/graph-ui`):

- **`GraphEditor` props** (all optional except `initialGraph`): `onChange`, `onSelectionChange` (selected node ids; select-only and dimension-only changes do not call `onChange`), `onEdgeSelectionChange` / `onEdgeDoubleClick`, `edgeTypes` / `defaultEdgeOptions` (Animation Graph uses `{ type: "animTransition" }`), `focusedNodeId` (select + fit/pan), `diagnostics` (red node badges for `severity: "error"`), `onNavigateRequest`, `paletteNodes` + centered **Add node** catalog modal (opened by toolbar **+**, double-tap pane, empty-pane context menu, or a far pin-drag release; not a persistent floating button), `defaultZoom` (opening / Controls / focused-node fit-view cap; default 0.5 from Engine Settings `graphDefaultZoom`), `readOnly` (ScriptInterface signature preview: pan/zoom only; no connect, node drag, palette, or Cut/Paste/Delete/Format). Small graphs do not zoom in past that value; large graphs still fit down to min zoom 0.1. External `initialGraph` updates (undo/redo, Inspector, Class members) reconcile onto the canvas without emitting `onChange`; parent echoes of the last emit are ignored so a drag is not snapped back.
- **`GraphDocument`**: local extension of core `SerializedGraph`; edges may carry optional `sourceHandle` / `targetHandle` for pin-aware wiring and optional `type` (React Flow edge component; Animation Graph persists `"animTransition"`). Optional `members` round-trip Class panel rows; optional `components` round-trip Actor prefab rows; optional `functionGraphs` hold per-function Input/Output graphs. `data.__protected` Input/Output nodes are movable but not deleted, copied, cut, or duplicated.
- **Nodes**: scripting nodes render via `PinNode` when `data.__pins` is present. Chrome is Blueprint-like: role-colored title bar (`--node-*`) clipped to the shell radius (`overflow-hidden` + `rounded-t-lg`) while the error badge sits outside that clip, two-column pin rows (`zipPinRows` packs leftover data pins into empty opposite-side cells on extra exec rows, so Branch Condition sits beside False), exec diamonds, data circles, and array list bars. Pin visuals stay hollow until a wire lands (`data-pin-connected="false"|"true"`), then fill. Default shell min-width is `min-w-80` (compact BT `min-w-56`); titles use `text-base`. Each pin row is `--touch-target` (44px) tall; the visual pin is `--graph-pin-size` (22px); pin names use `text-base`. Unconnected literal data inputs show a compact read-only default preview between the hollow pin and the name (`data-pin-default`; bool checkbox and color swatch at `size-5`, or a `text-base` / `h-8` truncated field capped at `--graph-pin-default-max-width`). Previews are not inputs (`pointer-events-none`); wiring the pin hides them. Titles wrap; `flow.event.*` without `data.title` formats as **Event …**. Tap output pin → tap input pin to connect. Legacy `logMessage` without pins still uses the same shell until the host hydrates. Development Only and Editor Only (`data.__editorOnly`) draw hazard-tape footers.
- **Host pin hydration** (`hydrateSerializedGraphForEditor` in the editor): injects `__pins` plus `__category` / `__pure` / `__latent` from `@babylonslate/scripting-nodes` on load; stamps `data.__editorOnly` from `editorOnly` defs. Palette entries carry `pins`, `pure`, `latent`, `editorOnly`, and `defaultData` so Add node creates connectable, colored handles. `graph-ui` stays free of the catalog package. It depends on `@babylonslate/scripting` for `resolveWildcardPinTypes` (pin/wire colors follow resolved display types without persisting them), Development Only detection, and literal pin-default preview values.
- **New graphs** seed native events from `nativeEventStubs` via `createDefaultLogicGraphSerialized` (Actor: Begin Play + Tick; UserInterface Logic with authored `parentClass` BObject: Begin Play + Tick when `assetType` is `UserInterface`; EditorUtilityInterface: Event Editor On Begin Play only; EditorUtilityObject: Editor On Begin Play + session events; BT parents as in Class Events; FunctionLibrary / EditorFunctionLibrary / BObject: empty). When a parent class is set, each seeded Event is default-wired to **Call &lt;Event&gt; Parent** (`flow.event.callParent` → `ctx.invokeEvent(parentClassId, …)`); inherited custom events from parent graphs are also placed and wired the same way. Seeding runs on create / first Event place only — not on hydrate — so deleting or moving Call Parent sticks. Existing `logMessage` graphs hydrate to `debug.log` pins without auto-injecting events. Class Add Node uses `scriptPaletteNodes({ parentClass, parentOf, classId, graph, otherClassGraphs, activeFunctionId, functionLibraries, animationGraphHost, assetType })` so BT leaf events do not appear on Actor graphs, editor-only defs stay off runtime hosts, Animation Graph Object/rule palettes stay exclusive (`"object"`: `anim.event.*` + runtime nodes; `"rule"`: `anim.state.*` + pure + Get Variable), and Call Custom Event / Call Function / Get Variable / Set Variable / **Cast to `<Class>`** rows are injected per class member or known class (locals only when that function graph is open). Actor palettes hide all `anim.*`. Closed Class headers participate in the symbol table (`classHeaderMeta`) so Get/Set/Call and Cast rows do not require the target Class tab to be open. Static FL Call Function rows come from open FL docs and `header.payload.functions`. UserInterface Logic defaults authoring `parentClass` to BObject (Actor stubs are not seeded; Begin Play / Tick stay in the catalog via `assetType`) and passes its graph so UI Variables get Get/Set and bound **Get Widget** rows. Hydrate regenerates `flow.event.call`, `flow.event.callParent`, `functions.call`, `flow.function.input`, `flow.function.output`, `variables.get`, `variables.set`, `ui.getWidget`, and `casting.cast` pins so type, Target, Class function Input/Output, widget refs, and Cast Result handles stay in sync. Unconnected Cast nodes retitle to `Cast to <Class>`; a wired Class pin retitles to `Cast to Class`.
- **Undo**: `AddNodeCommand` / `RemoveNodeCommand` / `SetGraphMembersCommand` / `SetGraphComponentsCommand` / `SetGraphFunctionGraphsCommand` (`graph.setFunctionGraphs`) in `@babylonslate/edit` so palette adds, Class panel members, function slices, and prefab components persist through `diffGraphCommands`. Chrome Undo/Redo (and desktop Mod+Z / Mod+Shift+Z / Mod+Y) apply that stack to the document **and** the canvas via GraphEditor reconcile. The Class graph panel hydrates from document **content** identity (`updateGraph` mutates the open-doc wrapper in place). Shader, Animation Graph Object, and UserInterface Logic share the same shell. Animation Graph State Machine uses custom `anim.state` nodes and `animTransition` edges.
- Tap-to-connect and drag-to-connect both persist (`onConnect`). `edgesAfterConnect` keeps exec fan-in/fan-out and data fan-out, and **replaces** any existing wire on a data input. A pin drag into the empty-canvas zone (outside a 96px screen-space safe zone around the source pin and compatible opposite pins, and not over a node) shows a **Tap to Cancel** badge. **Releasing** in that zone opens Add Node; a pick places the node at the **wire-end flow position** from the drag pointer at release (`screenToFlowPosition`, same conversion as Behaviour Tree release add-node). A **second pointer** while the drag is held ends the rubber-band and does **not** open Add Node; lifting the drag finger after that cancel must not open the catalog. With **Context Sensitive** on, that menu is pin-filtered and auto-wires with the same replace rule; with it off, the menu is the host-legal catalog. Releasing without a snapped handle and without opening Add Node removes every edge on the dragged pin, unless the pointer is still over the source handle (tap-to-connect) or still in the Add Node zone (release opens Add Node instead of breaking). Palette uses the shared Dialog catalog shell (`@babylonslate/ui` Dialog + ScrollArea) with a role-color chip per item.
- **Hold empty pane ~250ms then move** marquees (`attachGraphPaneMarquee` overlay in wrapper-relative screen pixels from pointer or `touches[0]` client points; one-finger pan until the hold arms, then mouse/touch pan is swallowed and `panOnDrag` is off). Overlay **Break Links** drops every incident wire on the selection (nodes stay). Overlay **Format** walks each selected chain root independently (`graph-format.ts`): exec then-chain stays a horizontal highway; stacked exec successors sit a node-height apart; data/pure trees hang below-left of their consumer (not on the exec row). A selected pure node walks data-out down-right. Unconnected parents do not merge onto the first path; overlapping boxes are pushed apart.
- Pin and wire colors use `--pin-*` tokens (exec white, bool red, float green, string magenta, vector yellow, …). Exec wires are 5px, data wires 4px. Unbound wildcards use `--pin-wildcard`; once a type is wired in, resolving groups and boxed display types paint with the concrete token. The canvas forces XYFlow `colorMode="dark"` (chrome theme does not wash the graph) and `--xy-*` overrides in `graph-editor.css`.
- Canvas zoom: `GRAPH_MIN_ZOOM` 0.1 / `GRAPH_MAX_ZOOM` 1.5 (wheel, pinch, and Controls zoom buttons). Double-click / double-tap does not zoom (`GRAPH_ZOOM_ON_DOUBLE_CLICK` / XYFlow `zoomOnDoubleClick={false}`) so empty-pane double-tap can open Add Node. Opening `fitView`, Controls fit-view, and focused-node fit (Class Events / diagnostics) all cap at Engine Settings `graphDefaultZoom` (default 0.5). `fitView` on a large graph may pull back to 10%.
- Blocking Preview dialog uses `AlertDialog` (editor host).

Reusable by shader / animation / BT graphs later: keep graph-kind plugins (node types, validation binder) injectable; do not hardcode scripting-only assumptions into the canvas host.

### Pin defaults (Inspector + canvas)

Unconnected data inputs can store a literal used at compile time when no wire is present (`pinExpr` reads `properties["default:"+name]` then `properties[name]`, else the type-table default). The Inspector edits `default:${name}` so pin defaults do not collide with node properties (`severity`, `body`, `count`, …). Connected pins hide the default field.

The graph canvas shows the same value as a **read-only** preview on the node (`PinDefaultPreviewWidget`): handle → preview → name. Bool is a decorative checkbox and color is a swatch (`size-5`); other literal kinds use a `text-base` / `h-8` truncated field (`max-width: var(--graph-pin-default-max-width)`). Previews are not focusable and do not change the graph — Inspector remains the editor. Wiring the pin hides the preview.

| Editable | Not in v1 |
| --- | --- |
| `bool`, `int`, `float`, `string`, `vec2`, `vec3`, `vec4` (XYZW scrubs), `rotator`, `color` (RGB; preserve `w`), `enumRef` (member-name Select from open Enum documents / registry), `classRef` (`ClassPicker` filtered to subclasses of the pin’s `classId`; default is that constraint id), `assetRef` (`AssetPicker` with `allowedTypes` from `assetType`; default is a guid string) | `exec`, `objectRef` / `actorRef` (live instances — no Inspector default; implicit-self Target on Call is the exception), delegate, wildcards, `array`, `map`, `structRef`, `transform` |

Authored defaults on types that **accept** literals clear `pin.missing_input`. A stored default on an object/actor **instance** pin is `pin.invalid_default`; the compiler ignores it and emits `null`. Boxed-wildcard node values (Print, Set Blackboard) still compile. Spawn Actor / Add Component `classId` pins are `classRef("Actor")` / `classRef("ActorComponent")`.

### Validation UX (`p5-graph-validation`)

- Debounced edit-time pass → Compiler Results + inline node/pin markers.
- Canvas connections use `scriptPinCompatibility` (`isAssignable` + class hierarchy), not kind-only matching.
- Missing required object/actor inputs, extra data wires on one input, stale Get/Set/Call members, unknown class ids, and local-vs-class variable name collisions emit errors (`pin.missing_input`, `pin.duplicate_connection`, `member.missing_*`, `member.unknown_class`, `member.local_name_conflict`). Interface methods that a class declares but does not implement emit `interface.unimplemented`. Pin arity/type drift vs the ScriptInterface or parent function emits `interface.signature_mismatch` / `member.override_signature`. Interface implementation Output data pins without a wire or authored default are errors (`pin.missing_input`). Exec pins may have several incoming wires; extra data inputs are errors (the canvas replaces on connect).
- Content Browser compile-error overlay (same iconography as missing ref).
- Play button error-count badge.
- Global toolbar **Compilation Error** status next to Compile on graph documents (tap opens Compiler Results).
- Pre-Preview project sweep → blocking dialog with Play Anyway.
- Headless CI over golden fixture projects (`packages/scripting/fixtures/` — one broken graph per diagnostic code).

### Type assets (`p5-types`)

| Asset | Editor | Feeds |
| --- | --- | --- |
| Enum | Row editor | `enumRef` pin types |
| Structure | Field editor | `structRef` pin types |
| ScriptInterface | Signature editor (parameter-list editor) | Interface call nodes + class "implements" |
| FunctionLibrary | Class inheriting FunctionLibrary (EditorFunctionLibrary is a child base) | Static Call Function rows from open FL docs and `header.payload.functions`; EFL calls only on editor hosts |

## Runtime binding

Compiled class graphs bind to object-model lifecycle without changing dispatch shape:

- `BObject` / `Actor` / `GameInstance` / mounted `UserInterface` event graphs → handlers invoked from existing `onCreation` / `onTick` / `onDestroyed` (UI only while applied)
- ScriptInterface method graphs (function members with `implementsInterface`) → `ScriptBundleEntry.interfaceImplementations` bound onto `interfaceHandlers`; `dispatchInterface` merges handler results with pin defaults
- FunctionLibrary → module of static functions; palette injects Call Function rows (open docs + header index). EditorFunctionLibrary is editor-only.

Play path: compile project graphs → worker `loadScripts` control message → `loadCompiledModule` → `registerAnchors` → spawn scripted actors → tick.

### UserInterface logic

`payload.logic` is a Class graph compiled as `UserInterface:<guid>` / parent `UserInterface` (`logicGraphFromUiPayload`). Authoring `parentClass` still defaults to BObject so Actor stubs are not seeded; Begin Play / Tick stay in the catalog because `assetType` is `UserInterface`. EditorUtilityInterface Logic catalogs **Event Editor On Begin Play** (`flow.event.editorBeginPlay` → `onEditorBeginPlay`, `editorOnly`) and hides game Begin Play / Tick. Class members (variables, functions, ScriptInterfaces, custom events) compile onto that class id — not the file stem.

- **Lifecycle:** Apply constructs the typed instance, creates widgets, runs widget then UI `onCreation`, binds interfaces, emits `uiApply`. Tick calls `onTick` only while mounted. Remove reverse-tears widgets then the UI (`onDestroyed`) and emits `uiRemove`.
- **Widget events:** hosts post `uiWidgetEvent`; the worker invokes `onWidgetClick` / `onWidgetValue` / `onWidgetChecked` / `onWidgetText` on the owning UI with `{ widget, widgetId, value }` (`ctx.args`).
- **Nodes:** **Apply User Interface** `classRef(UserInterface)` → `objectRef(UserInterface)`; **Remove User Interface** / **Set Widget Visibility** take object refs; generic **Get Widget** is hidden — palette injects `Get <Name>` as `objectRef(ButtonWidget)` / …. Actor-only APIs no-op when `self` is a `UserInterface`. `getWidget` is scoped to that UI.
- **No Actor spawn:** `shouldSpawnScriptedActor` skips `UserInterface` / `UserInterface:*` / `*Widget`.

See [ui-runtime.md](ui-runtime.md) and [bridge.md](bridge.md).

### Entry points

`Event Begin Play` (`flow.event.beginPlay`) and `Event Tick` (`flow.event.tick`) are entry nodes on Actors and UserInterface Logic. `Event Editor On Begin Play` (`flow.event.editorBeginPlay` → `onEditorBeginPlay`) is the editor-only entry on EditorUtilityInterface and EditorUtilityObject (no Tick). Custom events (`flow.event.custom`) are also entries; the compiler names the export from the member (`On_Hit`). The compiler emits one exported function per entry node, named after its event, so a single graph module can export both `onBeginPlay` and `onTick`. A graph whose only entry is `flow.entry` exports `run` and binds to nothing.

`CompileResult.entryPoints` reports `{ name, event, nodeId, isAsync }` per export. An entry point is async when it contains a latent node (`Delay`, async `ExecuteJavaScript`); `ScriptHost` skips a latent entry point that is still pending so a per-tick event cannot stack one run per frame.

### `ScriptHost` (`@babylonslate/runtime`)

`ScriptHost.load(script)` loads a compiled module and `hooksFor(classId)` returns `LifecycleHooks` that run its entry points. `RuntimeDriver.loadScripts()` registers each bundle's class id into the world's `ClassRegistry` (`parentClassId`, `implementedInterfaces`, variable defaults), registers modules plus their anchors, and `spawnScriptedActor({ classId })` / scene instantiate apply those defaults. Throws inside a script become runtime diagnostics mapped back to the graph node through the anchor table. `InfiniteLoopError` uses code `runtime.infinite_loop` and aborts the rest of that tick (one shared budget for all actors).

The `ctx` handed to compiled code copies the world's `TickContext`: `self`, `deltaSeconds`, `formatValue`, `checkInfiniteLoop`, `log`, `print`, variable access (`getVariable` / `setVariable` on self; `getVariableFrom` / `setVariableOn` for a Target instance), transform writes, tick-clock `delay` (pause-safe, not `setTimeout`), interface dispatch via `dispatchInterface` (`guid:method` keys, pin defaults when the target does not implement the method; `callInterface` forwards an args object and returns handler results), input (`isActionHeld` / `wasActionPressed` / `wasActionReleased` / `getAxis` / `getAxis2D` / `setGamepadRumble` / `gamepadConnections`), `addComponent`, `spawnActor`, `isA(instance, classId)` (`ClassRegistry` ancestry), `invokeCustomEvent(target, eventName, args)` (dispatches on `target.classId` with `self = target`), `invokeFunction(target, functionName, args)` (instance Calls look up `exports[functionName]` on `target.classId`; static FunctionLibrary Calls pass the library class id string, e.g. `ctx.invokeFunction("MathLib", "Add", …)`), `commandArgs` plus alias `args` (function Input nodes and custom event outputs), synchronous physics queries (`lineTrace`, `sphereOverlap`, `shapeSweep`, `addImpulse`), UI helpers `getWidget` (scoped to a `UserInterface` self), `setWidgetVisible` (Widget object or id), `applyUserInterface` (classRef / guid → typed `UserInterface` or `null`), `removeUserInterface` (object or instance id), `changeScene` (loads a scene from the Play scene library, same as console `changescene`), `playSound` (emits a `playSound` command; Play logs it — there is no mixer yet), and `setRenderResolution(width, height)` (emits `setRenderResolution`; Play applies `setSize` for the session only). Actor-only transform / physics / component APIs no-op when `self` is a `UserInterface`. Missing helpers must fail validation or emit a command; they must not silently no-op.

`ScriptHost.invokeEvent(classId, event, self?, args?)` (and `RuntimeDriver.invokeScriptEvent`) passes `args` into the compiled entry as `ctx.commandArgs` / `ctx.args`. Cross-instance Call uses the target actor’s class id, not the caller’s.

`RuntimeDriver` constructs the session `GameInstance` from `gameInstanceClass` (project picker, scene fallback), not a hardcoded `"GameInstance"` id, and binds compiled interface handlers onto spawned actors from class-declared interface guids (no hand-passed array required).

`compileGraphDocument` copies Class member variables (excluding function locals) and ScriptInterface `assetGuid`s onto `ScriptBundleEntry`, plus optional `parentClassId` from the asset header. UserInterface `payload.logic` compiles the same way with explicit `classId` `UserInterface:<guid>` and `parentClassId` `UserInterface` (`logicGraphFromUiPayload` / `userInterfaceClassMetadata`) — not the file stem. Function compiles pass `localPreamble` (`let __lv_*`) into `compileGraph`.

### Codegen invariants

- Impure node output slots are declared once at the top of each entry point, never inside a branch body — a node reachable from two `Sequence` outputs or both `Branch` arms must not redeclare them, and downstream reads must stay in scope.
- Editor / debugger compiles (`compileGraphDocuments`, `instrumentInfiniteLoops: true`) prepend `ctx.checkInfiniteLoop();` to each impure exec emit and to generated `for` / `while` bodies (for example the gamepad connect loop). Release `compileGraphDocumentsForExport` leaves the flag off — no checks in shipped JS. Call Function recursion shares the same per-tick budget.
- `ctx.checkInfiniteLoop` is always a function on `ScriptContext` (no-op when the debugger guard is missing or disabled) so mixed or stale instrumented scripts cannot throw `is not a function`.
- A node that emits `await` must call `ctx.requestAsync()` (or declare `latent: true`) so the entry point is emitted `async`.
- Statements must not introduce fixed-name temporaries; assign into `ctx.output(pin)` slots instead, since a node can be emitted more than once per function.

### Editor Play wiring

Play (`requestPlay`) saves dirty documents and compiles project graphs **before** the overlay launches. If anything still needs saving or compiling, a non-dismissible progress dialog (`play-prepare-dialog`) lists dirty names and the current phase (`Saving…` / `Compiling…`). A clean project with a current compile skips the dialog. After compile, blocking diagnostics open the existing Play Anyway dialog; Play Anyway launches with the bundles just produced and does not skip save/compile. Schema migrations abort prepare and reuse the migrate-on-save dialog; Play resumes after approval.

`collectPlayPreviewScripts()` (document context) loads every graph in `ProjectDocument.graphs` (open in-memory documents first, else disk) **plus** `payload.logic` from every UserInterface asset **plus** `compileAnimGraphScripts` for every AnimationGraph (`AnimGraph:{guid}` / `AnimRule:{guid}:{transitionId}`, `parentClassId: "BObject"`), validates that set, and compiles to `ScriptBundleEntry[]`. UI bundles carry class metadata (`UserInterface:<guid>`, parent `UserInterface`, variables, interfaces). `startPlaySession({ scripts })` ships them to the worker after `loadUserInterfaces`, or loads them into the in-process runtime when no worker is available. Class graphs still derive `classId` from the file stem (`main.class.babasset` → `main`). UserInterface logic does **not** — `spawnListForScripts` / `shouldSpawnScriptedActor` skip `UserInterface` / `UserInterface:*` / `*Widget` so Apply cannot create a rogue Actor. Animation Graph scripts use the `AnimGraph:` / `AnimRule:` prefixes so they also do not spawn extra actors. See [anim-graph.md](anim-graph.md) and [ui-runtime.md](ui-runtime.md).

A `runtime.infinite_loop` diagnostic **stops Play immediately** (overlay and Preview Build) and opens the Preview session report with message **Infinite loop detected**. Other runtime throws still wait for Stop. See [debugger.md](debugger.md).

## Acceptance (phase)

An actor scripted in the editor compiles and runs in the worker; a type mismatch is flagged before Preview and tap-to-navigate focuses the pin; an ExecuteJavaScript node round-trips values through the graph; compiler golden tests cover IR→JS + anchors.

## Explicit non-goals / deferrals

| Item | Owner |
| --- | --- |
| Full physics / input node behaviour | Queries, impulse, and `physics.moveCharacter` done (P7) |
| ExecuteConsoleCommand registry + debug-tier warnings | P8 (`p8-command-system` landed) |
| BDebugCommand / OnCommandRun / Play console + trace | P8 (landed) |
| Keyed Print HUD polish | P8 / export |
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

**Follow-ups (non-blocking polish):** tracked as a table under [issue-tracker P5 follow-ups](../agents/issue-tracker.md#p5-follow-ups--open-deferrals). **Development Only** (Inspector flag, Print default, `compileGraphDocumentsForExport`) is landed — do not reopen Print-strip as a P5 gap. Pin hydration, palette pins, Begin Play/Tick defaults, AddNode undo persistence, **drag-to-connect**, **Format**, **hold-to-marquee**, **class-owned graphs**, and **Enum / Structure / ScriptInterface DockView editors** are landed.

- Blob-URL dynamic import in WKWebView — spike early; fallback already in `loadCompiledModule`.
- Re-parenting class invalidation — design Class panel UX against `ClassRegistry.reparent` from the start.
- Blocking Preview dialog becoming dismiss-reflex — Play Anyway + "don't ask again"; demote noisy rules rather than harden the dialog.
- ExecuteJavaScript unsandboxed — disclose on import when assets contain JS bodies.
- Anchor tables invalidated by code moves — rewrite offsets on concat; never minify.
