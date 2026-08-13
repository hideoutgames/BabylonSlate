# Visual scripting (P5)

Shared surface for graph IR, pin types, validation, and JS codegen (engineplan §6, §6.1–6.2, §9.7 anchors, checklist `p5-*`). New packages: `@babylonslate/scripting`, `@babylonslate/scripting-nodes`. Editor shell: `@babylonslate/graph-ui` + class / type asset panels in `apps/editor`.

P4 already owns stack→node mapping (`AnchorEntry`, `loadCompiledModule`, Preview session report). P5 fills the compiler that emits those anchors and the editor that navigates to them.

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

`scripting-nodes` depends on `scripting` (types + codegen helpers). `scripting` must not depend on `scripting-nodes` — the compiler takes a **node registry** injected at compile time so catalog categories stay independently testable.

## Graph IR

Replace today's placeholder `SerializedGraph` (untyped nodes + edges without pin ends) with a typed IR stored on the **Class** asset payload (every class parent: `BObject`, `Actor`, `ActorComponent`, `GameInstance`, `FunctionLibrary`, `BDebugCommand`). New files use `.class.babasset`. Legacy `type: "Graph"` / `.graph.babasset` still loads and rewrites to Class on save. **UserInterface** keeps its own Design + Logic editor and is not a Class. Prefab + Components dock tabs appear only when Class ancestry includes **Actor**; other classes get Graph, Class, Inspector, and Compiler Results.

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
| Refs | `objectRef(classId)`, `actorRef(classId)`, `structRef(guid)`, `enumRef(guid)` |
| Containers | `array(T)`, `map(K, V)` |
| Other | `delegate(signature)`, `resolvingWildcard`, `boxedWildcard` |

**Assignability (summary):**

- `int` → `float` widening; never the reverse without an explicit cast node.
- Subclass object/actor refs assignable to superclass refs (via class registry).
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

**Rule registration hook:** `registerValidationRule(rule)` so `behaviour-tree` (P11) adds BT structural rules without a second linter. P5 ships the core rule set only; the hook and its contract are required from day one.

**Rule groups (engineplan §6.2):** structural, pin typing, references (needs registry), signatures (needs class graph), semantic, ExecuteJavaScript parse, BT (later).

**When it runs:**

| Trigger | Scope |
| --- | --- |
| Edit (≈300ms debounce) | Open graph |
| Save | Document + dependents with reference diagnostics |
| Pre-Preview | Project graphs compiled for Play (`collectPlayPreviewScripts`); startup map / GameInstance / plugin EUO sweep still later polish |
| Export | Hard gate + export-only rules (Print strip, debug-tier commands) |
| CI | Golden fixture projects |

Warnings never block. Errors block Preview via dialog (tap-to-navigate + **Play Anyway** + Engine Settings "don't ask again"), not a hard refuse. Export-preset-only rules stay off the edit-time path.

## Compiler

IR → **plain JavaScript ES modules** (no TypeScript in the browser).

| Concern | Behaviour |
| --- | --- |
| Exec flow | Straight-line statements; Branch/Sequence/loops → native `if`/`for`/`while` |
| Pure data | Inlined expressions + CSE |
| Latent (Delay, Timeline, async ExecuteJavaScript) | Async generator state machines |
| FunctionLibrary | Module of static functions |
| Determinism | Stable text; golden tests are the primary gate |
| Anchors | Per-statement `{ line, column, assetGuid, graphId, nodeId, bodyLine? }` + `//# sourceURL=babylonslate:///<assetGuid>.js` |
| Load | `runtime.loadCompiledModule` (blob URL, `new Function` fallback) |
| Output location | Derived data outside the project folder (compiled scripts + anchor tables) |

Validator and compiler share the **type context builder** so a graph that validates compiles.

Anchor tables are position-based: any pass that moves generated lines (packed export concat) must rewrite offsets. Never minify compiled game scripts.

## Special nodes (§6.1)

Ship with the catalog but own dedicated designs (not one-line templates):

| Node | Notes |
| --- | --- |
| **ExecuteJavaScript** | Editable in/out pin lists (JS identifier validation); fixed exec in/out; body → module-scope named function with defaulted outputs; async → latent; CodeMirror 6 body editor (lazy, accessory key bar, selection enabled); parse errors → Compiler Results with `bodyLine`/`bodyColumn` |
| **Log** | Severity + category → runtime log / Output Log / ring buffer |
| **Print** | Boxed wildcard via `formatValue`; colour + duration; keyed registry replaces in place; worker sends command, HUD draws; export may strip or degrade to log |
| **ExecuteConsoleCommand** | Runs through `@babylonslate/debugger` command registry; returns success + output; compile-time warning when a literal names a debug-tier command |
| **Event On Command Run** | `BDebugCommand` entry; output pins from the parameter list; compiles to `onCommandRun` |
| **Report Command** | Sets the console success flag + output string for `OnCommandRun` |

Shared **parameter-list editor** (typed named reorderable rows: type, optional, default, enum, up/down) lives in `editor-kit` — reused by ExecuteJavaScript Inputs/Outputs, Class / ScriptInterface signatures, and `BDebugCommand` / Event On Command Run.

## Node catalog (`scripting-nodes`)

One module + one test file per category:

`flow`, `math`, `vector`, `string`, `array`/`map`, `actor`, `component`, `transform`, `physics` (LineTrace, Sphere Overlap, Shape Sweep, Add Impulse — sync on calling exec pin), `input`, `audio`, `ui`, `scene`, `debug`, `interface`, `variables`, `casting`, `timers`.

Each node: `{ id, title, category, pins, codegen(ctx) }`. Physics/input nodes may register with compile-time "not yet available" or emit TODOs that fail validation until those phases — prefer stub codegen that throws a clear diagnostic over silently no-op.

AI / navigation categories wait for P11.

## Editor surfaces

### Class document

- **Graph** canvas (event + per-function graphs). **Double-tap empty pane** opens the unfiltered Add Node catalog (`Dialog` with categories + search; search is **not** autofocused). Drag-to-connect and tap-to-connect both persist. Pin-drag Add Node uses a 96px screen-space safe zone around the source pin and compatible pins; a live **Add Node** hint follows the wire when a drop would open the catalog. A cancelled pin drag (no snap, no Add Node, pointer left the source handle) breaks every wire on that pin.
- **Class**: compact collapsible tree (Functions, Variables, Events, Interfaces — no Graphs section) stacked *under* Components, about 50% of the left stack. Inline **+** prompts for a name and writes `SerializedGraph.members` (normalized). Event names are Title Cased (`On Hit`; node title `Event On Hit`). Events also insert `flow.event.custom`; variables can drop a Get node. Clicking an event focuses that graph node. Class-owned documents remain a later follow-up.
- **Details** (dock title Inspector): canvas selection drives the target (first selected node; Compiler Results / Play focus as fallback). Empty selection shows an empty state — no ExecuteJavaScript fallback. Unconnected applicable data pins get literal defaults; ExecuteJavaScript still has pin lists + body; Log has severity / category.
- **Compiler Results**: diagnostics grouped by graph; tap → select node, pan canvas, flash pin (or scroll CodeMirror to `bodyLine`).
- **Prefab** (Actor): full-size center tab; 3D preview + gizmos; component tree reorder is session-local until P7 class persistence.
- **Components**: actor component tree in the left dock; Add Component uses the Place Actors catalog chrome.

### `graph-ui` rework

Touch-first React Flow 12 shell (`@babylonslate/graph-ui`):

- **`GraphEditor` props** (all optional except `initialGraph`): `onChange`, `onSelectionChange` (selected node ids; select-only changes do not call `onChange`), `focusedNodeId` (select + fit/pan), `diagnostics` (red node badges for `severity: "error"`), `onNavigateRequest`, `paletteNodes` + centered **Add node** catalog modal (opened by double-tap pane or connect-end, not a persistent floating button), `defaultZoom` (opening fit-view cap; default 0.5 from Engine Settings `graphDefaultZoom`). Small graphs do not zoom in past that value; large graphs still fit down to min zoom 0.1.
- **`GraphDocument`**: local extension of core `SerializedGraph`; edges may carry optional `sourceHandle` / `targetHandle` for pin-aware wiring. Optional `members` round-trip Class panel rows.
- **Nodes**: scripting nodes render via `PinNode` when `data.__pins` is present. Chrome is Blueprint-like: role-colored title bar (`--node-*`) clipped to the shell radius (`overflow-hidden` + `rounded-t-lg`) while the error badge sits outside that clip, two-column pin rows, exec diamonds, data circles, and array list bars. Each pin row is `--touch-target` (44px) tall; the visual pin is `--graph-pin-size` (22px). Titles wrap; `flow.event.*` without `data.title` formats as **Event …**. Tap output pin → tap input pin to connect. Legacy `logMessage` without pins still uses the same shell until the host hydrates.
- **Host pin hydration** (`hydrateSerializedGraphForEditor` in the editor): injects `__pins` plus `__category` / `__pure` / `__latent` from `@babylonslate/scripting-nodes` on load; palette entries carry `pins`, `pure`, `latent`, and `defaultData` so Add node creates connectable, colored handles. `graph-ui` stays free of the catalog package. It depends on `@babylonslate/scripting` only for `resolveWildcardPinTypes` so pin/wire colors can follow resolved display types without persisting them.
- **New graphs** seed `flow.event.beginPlay` + `flow.event.tick` via `createDefaultLogicGraphSerialized` (project scaffold + Content Browser create). Existing `logMessage` graphs hydrate to `debug.log` pins without auto-injecting events.
- **Undo**: `AddNodeCommand` / `RemoveNodeCommand` / `SetGraphMembersCommand` in `@babylonslate/edit` so palette adds and Class panel members persist through `diffGraphCommands`.
- Tap-to-connect and drag-to-connect both persist (`onConnect`). Connect-end on empty pane (outside a 96px screen-space safe zone around the source pin and compatible opposite pins, and not over a node) opens a pin-filtered palette and auto-wires. While that drop would open Add Node, a non-interactive **Add Node** badge follows the live wire. Releasing without a snapped handle and without opening Add Node removes every edge on the dragged pin, unless the pointer is still over the source handle (tap-to-connect). Palette uses the shared Dialog catalog shell (`@babylonslate/ui` Dialog + ScrollArea) with a role-color chip per item.
- **Hold empty pane ~250ms then move** marquees (`attachGraphPaneMarquee` overlay; one-finger pan until the hold arms, then mouse/touch pan is swallowed and `panOnDrag` is off). Overlay **Format** tidies the selection, or walks the exec/data then-chain to the right of a single selected node and lays out data-input trees to the left of those nodes (`graph-format.ts`).
- Pin and wire colors use `--pin-*` tokens (exec white, bool red, float green, string magenta, vector yellow, …). Exec wires are 5px, data wires 4px. Unbound wildcards use `--pin-wildcard`; once a type is wired in, resolving groups and boxed display types paint with the concrete token. The canvas forces XYFlow `colorMode="dark"` (chrome theme does not wash the graph) and `--xy-*` overrides in `graph-editor.css`.
- Canvas zoom: `GRAPH_MIN_ZOOM` 0.1 / `GRAPH_MAX_ZOOM` 1.5 (wheel, pinch, and Controls). Opening `fitView` is capped at Engine Settings `graphDefaultZoom` (default 0.5). `fitView` on a large graph may pull back to 10%. Focused-node fit still caps at 1.2.
- Blocking Preview dialog uses `AlertDialog` (editor host).

Reusable by shader / animation / BT graphs later: keep graph-kind plugins (node types, validation binder) injectable; do not hardcode scripting-only assumptions into the canvas host.

### Pin defaults (Inspector)

Unconnected data inputs can store a literal used at compile time when no wire is present (`pinExpr` reads `properties["default:"+name]` then `properties[name]`, else the type-table default). The Inspector edits `default:${name}` so pin defaults do not collide with node properties (`severity`, `body`, `count`, …). Connected pins hide the default field.

| Editable | Not in v1 |
| --- | --- |
| `bool`, `int`, `float`, `string`, `vec2`, `vec3`, `rotator`, `color` (RGB; preserve `w`) | `exec`, refs, enum, delegate, wildcards, `array`, `map`, `vec4`, `transform` |

Authored defaults also clear `pin.missing_input`.

### Validation UX (`p5-graph-validation`)

- Debounced edit-time pass → Compiler Results + inline node/pin markers.
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
| FunctionLibrary | Class inheriting FunctionLibrary | Static global nodes in the palette |

## Runtime binding

Compiled class graphs bind to object-model lifecycle without changing dispatch shape:

- `BObject` / `Actor` / `GameInstance` event graphs → handlers invoked from existing `onCreation` / `onTick` / …
- ScriptInterface method graphs → `interfaceHandlers` map already supported by `dispatchInterface`
- FunctionLibrary → imported static module

Play path: compile project graphs → worker `loadScripts` control message → `loadCompiledModule` → `registerAnchors` → spawn scripted actors → tick.

### Entry points

`Event Begin Play` (`flow.event.beginPlay`) and `Event Tick` (`flow.event.tick`) are entry nodes. The compiler emits one exported function per entry node, named after its event, so a single graph module can export both `onBeginPlay` and `onTick`. A graph whose only entry is `flow.entry` exports `run` and binds to nothing.

`CompileResult.entryPoints` reports `{ name, event, nodeId, isAsync }` per export. An entry point is async when it contains a latent node (`Delay`, async `ExecuteJavaScript`); `ScriptHost` skips a latent entry point that is still pending so a per-tick event cannot stack one run per frame.

### `ScriptHost` (`@babylonslate/runtime`)

`ScriptHost.load(script)` loads a compiled module and `hooksFor(classId)` returns `LifecycleHooks` that run its entry points. `RuntimeDriver.loadScripts()` registers modules plus their anchors, and `spawnScriptedActor({ classId })` creates an actor driven by them. Throws inside a script become runtime diagnostics mapped back to the graph node through the anchor table.

The `ctx` handed to compiled code carries `self`, `deltaSeconds`, `formatValue`, `log`, `print`, variable access, transform writes, `delay`, interface dispatch, input queries, synchronous physics queries (`lineTrace`, `sphereOverlap`, `shapeSweep`, `addImpulse`), UI helpers `setWidgetVisible`, `applyUserInterface` (returns an instance id), `removeUserInterface`, and `changeScene` (same `World.loadScene` path as the `changescene` console command). Remaining later-phase helpers (audio) resolve to inert stubs so a graph that references them still runs instead of throwing.

### Codegen invariants

- Impure node output slots are declared once at the top of each entry point, never inside a branch body — a node reachable from two `Sequence` outputs or both `Branch` arms must not redeclare them, and downstream reads must stay in scope.
- A node that emits `await` must call `ctx.requestAsync()` (or declare `latent: true`) so the entry point is emitted `async`.
- Statements must not introduce fixed-name temporaries; assign into `ctx.output(pin)` slots instead, since a node can be emitted more than once per function.

### Editor Play wiring

Play (`requestPlay`) saves dirty documents and compiles project graphs **before** the overlay launches. If anything still needs saving or compiling, a non-dismissible progress dialog (`play-prepare-dialog`) lists dirty names and the current phase (`Saving…` / `Compiling…`). A clean project with a current compile skips the dialog. After compile, blocking diagnostics open the existing Play Anyway dialog; Play Anyway launches with the bundles just produced and does not skip save/compile. Schema migrations abort prepare and reuse the migrate-on-save dialog; Play resumes after approval.

`collectPlayPreviewScripts()` (document context) loads every graph in `ProjectDocument.graphs` (open in-memory documents first, else disk), validates that set, and compiles to `ScriptBundleEntry[]`. `startPlaySession({ scripts })` ships them to the worker, or loads them into the in-process runtime when no worker is available. Class ownership of graphs is not modelled yet, so a graph's class id is derived from its file name.

## Acceptance (phase)

An actor scripted in the editor compiles and runs in the worker; a type mismatch is flagged before Preview and tap-to-navigate focuses the pin; an ExecuteJavaScript node round-trips values through the graph; compiler golden tests cover IR→JS + anchors.

## Explicit non-goals / deferrals

| Item | Owner |
| --- | --- |
| Full physics / input node behaviour | Queries, impulse, and `physics.moveCharacter` done (P7) |
| ExecuteConsoleCommand registry + debug-tier warnings | P8 (`p8-command-system` landed) |
| BDebugCommand / OnCommandRun / Play console + trace | P8 (landed) |
| Keyed Print HUD polish + strip-on-export preset UI | P8 / export |
| Behaviour-tree validation rules | P11 |
| Shader / AnimationGraph validators | P9 |
| Scene viewport Play badge on 3D viewport | P6 scene chrome (wire badge API in P5; host may be class-doc Play until then) |

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

Packages `@babylonslate/scripting` and `@babylonslate/scripting-nodes` are in-tree. Editor wires validation (Compiler Results, Play badge + Play Anyway `AlertDialog`), graph-ui tap-to-connect **and** drag-to-connect + CatalogDialog palette, Class panel, CodeMirror ExecuteJavaScript body editor, Enum/Structure/ScriptInterface creatable assets, `FunctionLibrary` engine base, `formatValue`, and validator fixtures.

Preview runs compiled graphs: `ScriptHost` binds Begin Play / Tick entry points to actor hooks, `Print` reaches the on-screen overlay, and `e2e/p5-scripting.spec.ts` covers both acceptance claims (a scripted actor running in Preview; a type mismatch blocking Preview with tap-to-navigate).

**Follow-ups (non-blocking polish):** tracked as a table under [issue-tracker P5 follow-ups](../agents/issue-tracker.md#p5-follow-ups--open-deferrals) (pin flash, richer type-asset field editors, project-wide validation sweep, async-generator latents, P8 console/Print export, P9/P11 node runtime categories). Pin hydration, palette pins, Begin Play/Tick defaults, AddNode undo persistence, **drag-to-connect**, **Format**, **hold-to-marquee**, **class-owned graphs**, and **compact type-asset settings tabs** are landed — do not reopen those as P5 gaps.

- Blob-URL dynamic import in WKWebView — spike early; fallback already in `loadCompiledModule`.
- Re-parenting class invalidation — design Class panel UX against `ClassRegistry.reparent` from the start.
- Blocking Preview dialog becoming dismiss-reflex — Play Anyway + "don't ask again"; demote noisy rules rather than harden the dialog.
- ExecuteJavaScript unsandboxed — disclose on import when assets contain JS bodies.
- Anchor tables invalidated by code moves — rewrite offsets on concat; never minify.
