# Behaviour trees (P11)

Shared surface for the tree IR, Blackboard, and deterministic evaluator (engineplan §14.1, checklist `p11-behaviour-tree`). Implementation: `@babylonslate/behaviour-tree`. No React, no Babylon — the evaluator runs in the game worker.

Authoring (`p11-bt-authoring`) and the React Flow host (`p11-bt-editor`) are in. `BehaviourTreeComponent` and `NavAgentComponent` are addable. Runtime `BTTask_MoveTo` drives the crowd when a navmesh and `NavAgentComponent` are present; the package evaluator still succeeds immediately when no task host is provided. **P11 is Done.** §18: `packages/runtime/src/p11-acceptance.test.ts` plus `e2e/p11-ai.spec.ts`.

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
- Custom leaves go through `BtTaskHost.tick`; omitted host still runs built-ins.
- Attached **services** tick while their owner is on the stack. Interval + `randomDeviationMs` use `options.seed` (default `0`) so the same seed yields the same schedule. Built-in `bt.service.setBlackboard`; other class ids go through `BtServiceHost.tick`.

Abort observers run **before** continuing the stack (Unreal-style):

| Mode | When | Effect |
| --- | --- | --- |
| `self` | Decorator condition becomes false while the decorated node is on the stack | Pop through that node; node fails |
| `lowerPriority` | Condition becomes true | Abort running descendants of **rightward** siblings under the nearest `selector` ancestor |
| `both` | Either | Both |

Table-driven coverage lives in `packages/behaviour-tree/src/abort-matrix.test.ts`.

## Validation

`validateBehaviourTree(doc, ctx)` emits `Diagnostic` values (`bt.missing_root`, `bt.unknown_child`, `bt.cycle`, `bt.composite_empty`, `bt.task_has_children`). One broken tree per code in `packages/behaviour-tree/fixtures/`.

`registerBehaviourTreeValidationRules()` installs a `bt.structural` rule on the scripting hook. `validateGraphs([], { assetGuid, behaviourTree })` runs the same codes so Compiler Results stay one list. `TypeContext.behaviourTree` is an optional unknown payload (parsed in this package).

## Authoring (`p11-bt-authoring`)

- Engine bases: `BTTask`, `BTDecorator`, `BTService`, `BTComposite`. Built-ins: Wait, MoveTo (crowd when the runtime host is attached), SetBlackboardValue, Loop / Cooldown / TimeLimit, BlackboardIsSet, CompareBlackboardValue. RotateToFace, PlayAnimation, and PlaySound are catalogued and **succeed** without a host (no facing / clip / mixer).
- `BehaviourTreeComponent` has `treeGuid` + `blackboardGuid`. Search / Add Component list it. Play loads trees like AnimationGraphs (`loadBehaviourTrees`) and `tickBehaviourTrees()` emits `btState`.
- Missing `treeGuid` / unloaded tree emits `bt.missing_tree`.
- Custom `classId` values run compiled `On Activate` / `On Tick` graphs (`bt.event.*`) and finish via `bt.finish`.

## Editor (`p11-bt-editor`)

- New Asset: BehaviourTree (selector → sequence → succeed) and Blackboard.
- Host is `AssetDocumentWorkspace` (not Dockview). `GraphEditor` takes `nodeTypes` / `nodesDraggable` / `toolbarExtra`. Composites and tasks are React Flow `bt.node` nodes; decorators/services are attached selectable rows.
- Layout is `d3-hierarchy` top-down; sibling drag snaps to `children[]` order. Re-layout button recomputes positions.
- Double-tap a task whose `classId` matches a Class asset opens that class document.
- Play: running branch + last result overlay and blackboard watch from `btState`. Session report `btNodeId` opens the tree and focuses the node.
- P8: `TraceFrame.bt` records stack, blackboard, lastResults, and nodeMemory. `restoreBtFromTrace` reapplies that state.

## Honest residuals

- RotateToFace / PlayAnimation / PlaySound succeed without a host.
- §18 patrol, live obstacle close, abort, compiled throw, and `.babtrace` BT replay are the headless harness. Editor e2e covers New Asset, bake, and session-report `btNodeId` (Playwright Preview throw is test-mode `previewThrow` when a tree is attached).
- Undo is already via `applyAssetDocumentChange`.

See [navigation.md](navigation.md) for navmesh / MoveTo. Spec: [engineplan.md](../engineplan.md) §14.1.
