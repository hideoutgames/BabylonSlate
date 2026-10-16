# Behaviour Tree

Behaviour Tree and Blackboard documents, the deterministic evaluator, runtime task hosts, live editor state and the tree editor.

## Ownership

| Area | Source |
| --- | --- |
| Tree + Blackboard documents, parse/normalize, evaluator, abort matrix, validation, catalog, edit ops | [`packages/behaviour-tree/src/`](../../../packages/behaviour-tree/src/) (`evaluate.ts`, `validate.ts`, `builtins.ts`, `catalog.ts`, `edit.ts`, `serialize.ts`) |
| Structural validation fixtures | [`packages/behaviour-tree/fixtures/`](../../../packages/behaviour-tree/fixtures/) |
| Runtime host, task hosts, `btState` | [`packages/runtime/src/behaviour-tree-runtime.ts`](../../../packages/runtime/src/behaviour-tree-runtime.ts), [`bt-blackboard.ts`](../../../packages/runtime/src/bt-blackboard.ts) |
| Editor selection and observers | [`apps/editor/src/context/behaviour-tree-editing-context.tsx`](../../../apps/editor/src/context/behaviour-tree-editing-context.tsx), [`apps/editor/src/lib/bt-state-observers.ts`](../../../apps/editor/src/lib/bt-state-observers.ts) |

## Boundaries

- `@babylonslate/behaviour-tree` imports only `@babylonslate/core`, `@babylonslate/scripting` (pin types, `Diagnostic`) and `d3-hierarchy`. No React, Babylon or Capacitor; the evaluator runs in the game worker.
- BT diagnostics come from `validateBehaviourTree`, called directly by the editor for canvas badges and Compiler Results. They do not run through the scripting `validateGraphs` hook.
- Undo goes through `applyAssetDocumentChange`.

## Tree IR

- Parent–child edges, not exec wires; sibling order is `children[]`. Decorators and services are attached rows on a node, not tree positions.
- Each node has one parent: the evaluator uses the first parent a depth-first walk reaches and drops back-references (`bt.multiple_parents`, `bt.cycle` diagnostics).
- Kinds: `selector`, `sequence`, `parallel`, `task`. Custom `BTComposite` subclasses are data: `kind` comes from ancestry (`kindForCatalogClassId`; bare `BTComposite` → sequence). There is no scripted composite VM.
- Default document: selector root → sequence → `bt.task.succeed`. Files: `.bt.babasset`, `.blackboard.babasset`.
- `editorPositions` is optional editor data; runtime ignores it. A finished move writes positions and re-sorts siblings by X; Auto Arrange writes positions and never changes `children[]`. Each finished move is its own undo step (no shared merge key).

## Evaluator rules

- Pure `(tree, previous, dtSeconds, options?) → BtEvalState` with an explicit `{ nodeId, childIndex }` stack (no recursion). Walk-derived indexes are cached per document object; replace documents instead of mutating them.
- Aborts follow Unreal: `self` fails an active branch when its condition is false; `lowerPriority` aborts a later selector child only when the observed result changes false → true and the higher branch is eligible. Observed results live in `nodeMemory` (`__obs:<decoratorId>`).
- A new execution gets fresh instance memory except `__cd:` cooldown keys. An empty stack at the start of an evaluate restarts from root.
- Loop restarts with `dt = 0` inside the tick; an infinite Loop restarts at most once per tick. Cooldown counts from the next tick and survives restarts. TimeLimit fails a running node past `durationMs`.
- Parallel ticks every child each step; nodes with `lastResults === "running"` stay active for TimeLimit, services, self-abort and task abort even off the stack.
- Services tick while their owner is active, at most once per tick; missed intervals are dropped. Random deviation uses `options.seed`. Missing `intervalMs` reads as 250 ms.
- Custom tasks go through `BtTaskHost.tick` / `abort`; unknown decorators through `BtDecoratorHost.evaluate` (no host → true); services through `BtServiceHost.tick`. Without a host, `HOST_TASKS` (move, rotate, play animation, play sound) stub-succeed so package tests stay Babylon-free.
- Completion after abort or teardown is ignored, so a stale continuation cannot finish a restarted task.

## Runtime hosts

- `BehaviourTreeComponent` (`treeGuid`, `blackboardGuid` override). `BehaviourTreeRuntime.tick` visits only owners from the shared component owner index ([object-model.md](object-model.md)). Changing tree or blackboard aborts running tasks and restarts with fresh defaults; each evaluation copies array/object defaults. Missing tree → `bt.missing_tree`.
- Move To / Move To Blackboard Key drive the navigation crowd; abort calls `stopNavAgent`.
- Rotate To Face writes yaw only and teleports the physics body like script transform writes.
- Play Animation emits `animState` (`stateId: "bt.playAnimation"`) and suppresses the Animation Graph for that slot while owned; abort or slot release ends ownership.
- Play Sound uses the shared `playSound` path with stable `voiceId` `bt:${actor.guid}:${node.id}` and omits `loop` (the Audio asset decides). The tree owns its voices; abort and actor removal stop them.
- Trace frames record stack, blackboard, results, node memory, `playAnimationOwned` and `playSoundVoiceIds`; `restoreBtFromTrace` restores evaluation and ownership.

## Live editor state

- `btState` has one consumer: the BT editor during editor Play. The runtime publishes it only while observed (`setBehaviourTreeStateObserved`) and only when state changed, so exported players and unobserved sessions do no sanitizing or sending.
- The editor counts observers (`useObserveBtState` while Graph or Blackboard is on screen); `PlayOverlay` toggles the control on 0 ↔ non-zero.
- Change detection compares a raw Blackboard copy (`copyBlackboard` / `sameBlackboard`): plain data by content, actors/components by identity. Traces read evaluation state directly, not `btState`.
- Console `behaviourtreedebug` is a separate debug-tier inspector with its own 5 Hz snapshots. All transported values are sanitized with the inspect formatter.

## Editor

- DockView kind `behaviour-tree`: Graph (primary, created first), Blackboard, Inspector, Compiler Results; Focus keeps Graph only.
- Root (`__protected`) has no parent pin and cannot be duplicated or deleted; Wrap In Sequence moves `__protected` to the wrapper.
- Inspector value rows follow the selected Blackboard key's `PinType`; changing the key writes that type's default. Blackboard keys are edited only in the Blackboard document.
