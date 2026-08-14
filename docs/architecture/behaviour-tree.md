# Behaviour trees (P11)

Shared surface for the tree IR, Blackboard, and deterministic evaluator (engineplan §14.1, checklist `p11-behaviour-tree`). Implementation: `@babylonslate/behaviour-tree`. No React, no Babylon — the evaluator runs in the game worker.

Authoring (`p11-bt-authoring`) and the React Flow host (`p11-bt-editor`) are in. The **authoring-surface** pass (`p-bt-editor-authoring`) fills typed Details, catalogs, tree operations, canvas diagnostics, honest Loop/Cooldown/TimeLimit, and the Play running-branch overlay. User subclasses now get ancestry-specific class events and runtime hosts (`p-bt-class-events`): `BTTask` On Activate / On Tick / On Abort, `BTDecorator` On Evaluate, `BTService` On Tick; `BTComposite` stays data (selector / sequence / parallel from ancestry, not a scripted VM). `BehaviourTreeComponent` and `NavAgentComponent` are addable. Runtime `BTTask_MoveTo` drives the crowd when a navmesh and `NavAgentComponent` are present; the package evaluator still succeeds immediately when no task host is provided. **P11 is Done.** Do not uncheck `p11-bt-editor` or `p11-bt-authoring`. §18: `packages/runtime/src/p11-acceptance.test.ts` plus `e2e/p11-ai.spec.ts`.

## Package

| Package | Owns | Must not import |
| --- | --- | --- |
| `behaviour-tree` | Tree + Blackboard documents, parse/normalize, explicit-stack evaluator, abort matrix, `bt.*` diagnostics, scripting rule registration | React, Babylon, Capacitor |
| `scripting` | Pin types for blackboard keys; `registerValidationRule` hook | React, Babylon, Capacitor |
| `graph-ui` / `apps/editor` | React Flow tree host (`AssetDocumentWorkspace`, `d3-hierarchy` layout, Play overlay) | Babylon, Capacitor |

`behaviour-tree` may import `@babylonslate/scripting` (pin types, `Diagnostic`, `ValidationRule`) and `@babylonslate/core`.

## Tree IR

Parent–child edges, not exec wires. Sibling order is `children[]` (`sortIndex`). Decorators and services are **attached rows** on a node, not independent tree positions.

| Kind | Role |
| --- | --- |
| `selector` | First child that succeeds |
| `sequence` | All children in order |
| `parallel` | Tick every child each step; fail if any fail, succeed if all succeed, otherwise running |
| `task` | Leaf. Built-in `classId` values (`bt.task.wait`, `BTTask_Wait`, `BTTask_MoveTo`, …) or a user `BTTask` subclass |

Abort modes on a decorator: `none` | `self` | `lowerPriority` | `both` (engineplan §14.1). Observer keys are blackboard names.

Default document: a `selector` root with one `sequence` child and one `bt.task.succeed` leaf. `parseBehaviourTreeDocument` / `parseBlackboardDocument` are the header-payload codecs (JSON round-trip). New Asset creates `.bt.babasset` / `.blackboard.babasset`.

## Blackboard

Separate asset. Keys use the scripting pin type system (`PinType` JSON). The evaluator holds a `Map` of name → value; missing keys are unset. Built-in decorator `bt.decorator.blackboardIsSet` / task `bt.task.setBlackboard` exercise the store without class graphs.

## Evaluator

Pure: `(tree, previous, dtSeconds, options?) → BtEvalState`.

- Explicit stack of `{ nodeId, childIndex }` — no recursion, so a tree can be stepped and inspected.
- Results: `success` | `failure` | `running`.
- `lastResult` per node for a later debug overlay.
- `btNodeId` on the running leaf (Preview / trace).
- Custom leaves go through `BtTaskHost.tick`; omitted host still runs built-ins. Popping a running **task** (self abort, lower-priority abort, time limit) calls optional `BtTaskHost.abort` once.
- Unknown decorator `classId` values go through `BtDecoratorHost.evaluate`; omitted host (or missing class / no `btEvaluate` call) is **true** so an empty subclass does not fail the tree. Built-in blackboard / compare / cooldown / loop / time-limit stay in the evaluator.
- **Loop** restarts the decorated subtree until `numLoops` (0 = infinite). **Cooldown** blocks the node for `durationMs` after it finishes (cooldown memory survives tree restart). **TimeLimit** fails a running node when elapsed time exceeds `durationMs`.
- When the stack is empty the next tick **restarts from the root** and clears instance memory except `__cd:` cooldown keys, so Wait / MoveTo / custom tasks run again instead of succeeding immediately.
- Attached **services** tick while their owner is on the stack. Interval + `randomDeviationMs` use `options.seed` (default `0`) so the same seed yields the same schedule. Built-in `bt.service.setBlackboard`; other class ids go through `BtServiceHost.tick`.

Abort observers run **before** continuing the stack (Unreal-style):

| Mode | When | Effect |
| --- | --- | --- |
| `self` | Decorator condition becomes false while the decorated node is on the stack | Pop through that node; node fails |
| `lowerPriority` | Condition becomes true | Abort running descendants of **rightward** siblings under the nearest `selector` ancestor |
| `both` | Either | Both |

Table-driven coverage lives in `packages/behaviour-tree/src/abort-matrix.test.ts`.

## Validation

`validateBehaviourTree(doc, ctx)` emits `Diagnostic` values (`bt.missing_root`, `bt.unknown_child`, `bt.cycle`, `bt.composite_empty`, `bt.task_has_children`, `bt.parallel_too_small`, `bt.missing_blackboard_key`). One broken tree per code in `packages/behaviour-tree/fixtures/`. `bt.missing_blackboard_key` runs only when `ctx.blackboardKeys` is provided.

`registerBehaviourTreeValidationRules()` installs a `bt.structural` rule on the scripting hook. `validateGraphs([], { assetGuid, behaviourTree })` runs the same codes so Compiler Results stay one list. `TypeContext.behaviourTree` is an optional unknown payload (parsed in this package).

## Authoring (`p11-bt-authoring`)

- Engine bases: `BTTask`, `BTDecorator`, `BTService`, `BTComposite`. Built-ins: Wait, MoveTo (crowd when the runtime host is attached), SetBlackboardValue, Loop / Cooldown / TimeLimit, BlackboardIsSet, CompareBlackboardValue. RotateToFace, PlayAnimation, and PlaySound are catalogued and **succeed** without a host (no facing / clip / mixer).
- `BehaviourTreeComponent` has `treeGuid` + `blackboardGuid`. Search / Add Component list it. Play loads trees like AnimationGraphs (`loadBehaviourTrees`) and `tickBehaviourTrees()` emits `btState`.
- Missing `treeGuid` / unloaded tree emits `bt.missing_tree`.
- Custom `classId` values run compiled graphs: tasks `On Activate` / `On Tick` / `On Abort` (`bt.event.*`) and finish via `bt.finish`; decorators `On Evaluate` plus `bt.returnCondition` (`ctx.btEvaluate`); services `On Tick`. Get/Set Blackboard (`bt.blackboard.get` / `bt.blackboard.set`) compile to `ctx.getBlackboard` / `ctx.setBlackboard`. Abort mode on a decorator stays a tree attachment property, not a class event.
- Runtime `BTTask_MoveTo` abort calls `stopNavAgent` and clears `__moveRequested` so the crowd does not keep walking the aborted path.
- Custom `BTComposite` subclasses are **data** composites: `kind` walks ancestry (`BTComposite_Selector` → selector, `_Sequence` → sequence, `_Parallel` → parallel, bare `BTComposite` → sequence). There is no scripted composite VM.

## Editor (`p11-bt-editor` + `p-bt-editor-authoring`)

- New Asset: BehaviourTree (selector → sequence → succeed) and Blackboard.
- Host is `AssetDocumentWorkspace` (not Dockview for this tab). `GraphEditor` takes `nodeTypes` / `nodesDraggable` / `toolbarExtra` / `hiddenToolbarActions` / `lockNodeDragAxis="x"`. Composites and tasks are React Flow `bt.node` nodes with Title Case titles; decorators/services are attached selectable rows (catalog titles, not raw `classId`).
- Layout is `d3-hierarchy` top-down; drag is sibling-only on X, then `children[]` reorder + re-layout. Re-layout button remains for import edge cases. Toolbar keeps Delete (root is `__protected`); Break Links and Format are hidden.
- Add Node palette: built-in composites/tasks plus project Class assets whose parent is `BTTask` / `BTComposite`. Custom composites take `kind` from ancestry (`kindForCatalogClassId`, bare `BTComposite` → sequence), not from the class name. Add Decorator / Add Service opens a `CatalogDialog` (built-ins plus `BTDecorator` / `BTService` classes). Attachments can be removed or moved up/down.
- Details: `PropertyGrid` schemas per `classId` (Wait duration, SetBlackboard key+value, MoveTo destination + accept radius, CompareBlackboard key/op/value, Loop count, Cooldown / TimeLimit ms, service interval / deviation, decorator abort + observed keys). Blackboard key fields pick from the linked Blackboard asset when that document is open.
- Blackboard editor: add / rename / typed default (bool / number / text) / delete key.
- Long-press `ContextMenuOverlay` on the node, attachment row, and empty pane (selected node): Add Decorator, Wrap In Sequence, Duplicate, Delete. Double-tap a node or attachment whose `classId` matches a Class asset opens that class document.
- `validateBehaviourTree` is passed to `GraphEditor` `diagnostics` (error badge on the node).
- Play: running **branch** from `btState.stack` (not only `btNodeId`) plus last-result overlay and blackboard watch. Session report `btNodeId` opens the tree and focuses the node.
- P8: `TraceFrame.bt` records stack, blackboard, lastResults, and nodeMemory. `restoreBtFromTrace` reapplies that state.

## Honest residuals

- RotateToFace / PlayAnimation / PlaySound succeed without a host.
- §18 patrol, live obstacle close, abort, compiled throw, and `.babtrace` BT replay are the headless harness. Compiled custom decorator On Evaluate (false gates Wait), On Abort, and service Set Blackboard live in `p11-acceptance.test.ts`. Editor e2e covers New Asset, add Wait + duration + keyed decorator + remove attachment, New Class parent `BTDecorator` (Events show On Evaluate, Add Decorator catalogs the class), bake, and session-report `btNodeId` (Playwright Preview throw is test-mode `previewThrow` when a tree is attached).
- Undo is already via `applyAssetDocumentChange`.
- Large-tree iPad virtualization (§19) is not this slice.

See [navigation.md](navigation.md) for navmesh / MoveTo. Spec: [engineplan.md](../engineplan.md) §14.1.
