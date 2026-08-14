# Behaviour trees (P11)

Shared surface for the tree IR, Blackboard, and deterministic evaluator (engineplan §14.1, checklist `p11-behaviour-tree`). Implementation: `@babylonslate/behaviour-tree`. No React, no Babylon — the evaluator runs in the game worker.

Authoring (`p11-bt-editor`), `BTTask` class graphs (`p11-bt-authoring`), and `BehaviourTreeComponent` Play tick stay later slices. `BehaviourTreeComponent` / `NavAgentComponent` remain catalog-gated.

## Package

| Package | Owns | Must not import |
| --- | --- | --- |
| `behaviour-tree` | Tree + Blackboard documents, parse/normalize, explicit-stack evaluator, abort matrix, `bt.*` diagnostics, scripting rule registration | React, Babylon, Capacitor |
| `scripting` | Pin types for blackboard keys; `registerValidationRule` hook | React, Babylon, Capacitor |
| `graph-ui` / `apps/editor` | React Flow tree host (later) | Babylon, Capacitor |

`behaviour-tree` may import `@babylonslate/scripting` (pin types, `Diagnostic`, `ValidationRule`) and `@babylonslate/core`.

## Tree IR

Parent–child edges, not exec wires. Sibling order is `children[]` (`sortIndex`). Decorators and services are **attached rows** on a node, not independent tree positions.

| Kind | Role |
| --- | --- |
| `selector` | First child that succeeds |
| `sequence` | All children in order |
| `parallel` | Tick every child each step; fail if any fail, succeed if all succeed, otherwise running |
| `task` | Leaf. Built-in `classId` values (`bt.task.wait`, `bt.task.succeed`, `bt.task.fail`, `bt.task.setBlackboard`) or a later `BTTask` subclass |

Abort modes on a decorator: `none` | `self` | `lowerPriority` | `both` (engineplan §14.1). Observer keys are blackboard names.

Default document: a `selector` root with one `sequence` child and one `bt.task.succeed` leaf. `parseBehaviourTreeDocument` / `parseBlackboardDocument` are the header-payload codecs (JSON round-trip); `.babasset` kinds stay ungated until `p11-bt-editor`.

## Blackboard

Separate asset. Keys use the scripting pin type system (`PinType` JSON). The evaluator holds a `Map` of name → value; missing keys are unset. Built-in decorator `bt.decorator.blackboardIsSet` / task `bt.task.setBlackboard` exercise the store without class graphs.

## Evaluator

Pure: `(tree, blackboard, previous, dtSeconds, host?) → BtEvalState`.

- Explicit stack of `{ nodeId, childIndex }` — no recursion, so a tree can be stepped and inspected.
- Results: `success` | `failure` | `running`.
- `lastResult` per node for a later debug overlay.
- `btNodeId` on the running leaf (Preview / trace).
- Custom leaves go through `BtTaskHost.tick`; omitted host still runs built-ins.

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

## Later slices (do not start here)

| Slice | Work |
| --- | --- |
| `p11-bt-authoring` | `BTTask` / `BTDecorator` / `BTService` / `BTComposite` base classes; ungate `BehaviourTreeComponent`; worker `tickBehaviourTrees()` (mirror `tickAnimGraphs`); built-in Wait / MoveTo (stub until nav) / blackboard conditions as classes |
| `p11-bt-editor` | `AssetDocumentWorkspace` host (not Dockview); parent–child `GraphEditor` nodeTypes; `d3-hierarchy` layout; Play overlay; session-report `btNodeId` navigation |
| Undo | `SetAssetDocumentCommand` via `applyAssetDocumentChange` |

See [navigation.md](navigation.md) for navmesh / MoveTo. Spec: [engineplan.md](../engineplan.md) §14.1.
