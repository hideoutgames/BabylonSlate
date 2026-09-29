# Command layer

Shared surface for P2 undo, dirty saves, and crash recovery (engineplan §§7.3, 2.4, 16.1). Implementation lives in `@babylonslate/edit`.

## Package API (`@babylonslate/edit`)

| Export                                                                                                                                                                                                                                                                                                                          | Role                                                                               |
| ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ---------------------------------------------------------------------------------- |
| `EditCommand`                                                                                                                                                                                                                                                                                                                   | Reversible mutation contract (`apply`, `invert`, optional `mergeKey` / `byteSize`) |
| `DocumentEditStack`                                                                                                                                                                                                                                                                                                             | Per-document undo/redo stack with entry + byte budgets                             |
| `EditSession`                                                                                                                                                                                                                                                                                                                   | Map of `docId → DocumentEditStack`; `apply` / `undo` / `redo` / `dropDocument` / `rekeyDocument` |
| `diffGraphCommands`                                                                                                                                                                                                                                                                                                             | Derives graph commands from before/after `SerializedGraph` snapshots               |
| `MoveNodeCommand`, `AddEdgeCommand`, `RemoveEdgeCommand`, `SetNodeDataCommand`, `SetGraphMembersCommand`, `SetGraphComponentsCommand`, `SetGraphFunctionGraphsCommand`                                                                                                                                                           | Graph document commands (`graph.setFunctionGraphs` keeps Class function slices on undo) |
| `AddActorCommand`, `RemoveActorCommand`, `SetActorTransformCommand`, `SetActorsTransformsCommand`, `RenameActorCommand`, `ReparentActorCommand`, `ReorderActorCommand`, `SetActorFlagsCommand`, `AddComponentCommand`, `RemoveComponentCommand`, `ReorderComponentCommand`, `SetComponentPropertyCommand`, `SetSceneSettingCommand`, `SetViewportModeCommand`, `AddFolderCommand`, `RemoveFolderCommand`, `RenameFolderCommand`, `ReparentFolderCommand`, `SetActorFolderCommand` | Scene document commands (`scene.setActorsTransforms` is one undo for a multi-select gizmo drag) |
| `SetAssetDocumentCommand`                                                                                                                                                                                                                                                                                                       | Asset-tab payload replace; optional `mergeKey` for paint strokes                   |
| `diffSceneCommands`                                                                                                                                                                                                                                                                                                             | Derives scene commands from before/after `SerializedScene` snapshots               |
| `serializeJournalLine` / `parseJournalLine`                                                                                                                                                                                                                                                                                     | JSONL journal line codec                                                           |
| `coalesceJournalLines`                                                                                                                                                                                                                                                                                                          | Folds consecutive records of one gesture (first `from`, last `to`)                 |
| `replayJournalLines`                                                                                                                                                                                                                                                                                                            | Replay journal onto open authored asset documents                                  |
| `journalRepathLine` / `resolveJournalLines` | Rename marker line; resolves each edit line to its document's final id before replay |
| `reviveCommand` / `registerCommandReviver`                                                                                                                                                                                                                                                                                      | Registry to rebuild commands from journal JSON                                     |

Editor wiring: `DocumentProvider` owns an `EditSession` configured with `DEFAULT_EDIT_BYTE_BUDGET` plus Engine Settings `undoHistoryLength`; graph panels call `applyGraphChange`, scene panels call `applySceneChange`, asset tabs call `applyAssetDocumentChange`; chrome **Undo** / **Redo** (and desktop Mod+Z / Mod+Shift+Z / Mod+Y) act on the active document only. `GraphEditor` reconciles that restored graph onto the canvas. `SetNodeDataCommand` and subtree-capturing scene commands (e.g. `RemoveActorCommand`) record `byteSize` so snapshot-style edits count toward the budget. Tilemap paint strokes pass `SetAssetDocumentCommand.mergeKey` (`tilemap-stroke:<id>`) so one undo restores the whole gesture. Continuous asset Details controls still commit on every pointer move (so every open viewport stays live) but pass a stable per-field merge key, so one scrub, color-picker drag or overlay drag is one undo step and cannot push earlier history past the entry cap: Water (`water:<field>`, numbers and colors), Particle Emitter (`particle-field:<path>`), Model collider rows, Sprite and Sprite Animation fields plus the collision overlay drag, Tileset layout/frame fields and the Paint Collision drag, Tilemap map and layer fields, Texture Compression Quality, Audio volume/pitch/clip Weight, Audio Mixer volumes, Sound Attenuation numbers, Animation Graph blend/priority/speed, Input binding scale/dead zone/sensitivity, Render Target size, Enum values, Structure and Blackboard defaults, Material settings, node properties and Material Function input defaults, Behaviour Tree node and attachment fields, and Asset Settings numbers. Animation Object and transition-rule graphs stored in an asset payload reuse the graph command's own key (`logicGraphEditMergeKey`) when an edit is a single graph command. Most hosts pass no key for discrete edits (toggles, picks, enum choices); Behaviour Tree node and attachment fields, Material node properties and Structure / Blackboard defaults key every row, discrete ones included, and the gesture boundaries below still make each separate click or key action its own undo step. Material node drags use `material-node-move:<transactionId>` so two sequential drags are two undos. Class / Graph and Animation Graph canvases also pass `commitPositionsOnDragEnd`: an in-flight node drag stays on the canvas and `applyGraphChange` (or the anim-graph commit) runs once on release instead of once per pointer frame; `MoveNodeCommand` keeps its `move:<nodeId>` merge key. Identical asset payloads are not applied, so a graph remount cannot re-dirty after Save All.

The active document ends its merge group at a new pointer gesture, input Enter, focus exit or discrete non-text key action. Multiple fingers within a continuous gesture and typing within one field remain grouped. Undo/Redo also close the merge group; Redo preserves the inverse from the start of the original gesture, so a subsequent Undo restores the same starting state.

**First-edit auto-lock (P15):** after the plugin read-only check and a successful apply, `afterMutatingApply` calls `SourceControlService.autoLock(path)` once per document path this session. Later edits on a path whose lock is already ours notify subscribers only when its banner or edit mode actually changes, so a scrub does not re-render the editor a second time per move. Source Control off, `autoLockOnEdit` false, or a plugin-read-only document skips it. HTTP 409 / offline never blocks the edit — see [source-control.md](source-control.md). Advisory theirs-locks use the same early-return shape as `isPluginDocumentReadOnly` (`isMutatingApplyBlocked`).

## Ownership

| Concern                                          | Owner                                                                 |
| ------------------------------------------------ | --------------------------------------------------------------------- |
| In-document mutations (graph, scene, properties) | `packages/edit` command stream                                        |
| Asset **file** create / delete / folder ops      | Asset registry (`packages/assets`) — **outside** undo                 |
| Persisting dirty documents                       | Editor services, triggered after command apply (`autoSaveIntervalMs`) |
| Journal (crash recovery)                         | Derived-data JSONL segments of the **same** command stream            |

The undo boundary is exactly the asset-file boundary. Editing surfaces must not mutate document models directly.

## Command object

```ts
interface EditCommand<TDoc = unknown> {
  readonly type: string;
  /** Coalesce continuous gestures (gizmo drag, slider scrub, node drag). */
  readonly mergeKey?: string;
  apply(doc: TDoc): TDoc;
  invert(): EditCommand<TDoc>;
  /** Snapshot-fallback cost in bytes; omit for compact deltas. */
  readonly byteSize?: number;
}
```

- Prefer **deltas**. Snapshot a touched subtree only when a compact inverse is impractical; record `byteSize` so expensive types show up in profiling.
- `invert()` returns a command that undoes `apply` (not a side-effecting undo method).
- Commands are serialisable for the journal (discriminated `type` + payload fields).

## Per-document stacks

- One `DocumentEditStack` per open document id — **never** a global undo stack.
- Closing a document drops its history.
- Renaming or moving an open document (`DocumentProvider.repathDocument`, the only rename path) moves its history to the new path-based id with `EditSession.rekeyDocument`, so Undo keeps working on the renamed tab and nothing remains under the old id — a document later created and opened at the old path starts with empty history. A stack already under the new id is dropped rather than inherited: its commands were recorded against another document's content. The same call appends a journal rename marker (see [Journal format](#journal-format)), moves the tab's Focus snapshots and Anim mode, releases the old workspace's dock handles, and (through `DocumentService` `repathed`) the [project session view state](scene-editing.md#project-session-view-state).
- Chrome undo/redo act on the **active** document only; buttons are the primary touch affordance. Desktop **Mod+Z** undoes, **Mod+Shift+Z** / **Mod+Y** redo (rebindable, see [keybinds.md](keybinds.md)); skipped in text fields / `SelectableText` and while three pointers are down. Graph canvases reconcile the restored document so node add/move/connect/delete is visible (same path as scene / UI Design / tilemap).
- Caps (both enforced; drop from the oldest end when either is exceeded):
  - **Entry limit** from Engine Settings `undoHistoryLength` (default 50).
  - **Byte budget** across recorded `byteSize` values (snapshot fallbacks).

Merge: if the new command’s `mergeKey` equals the top undo entry’s key, replace the top entry with a coalesced command (one undo step per gesture). `diffSceneCommands` emits `SetActorsTransformsCommand` when two or more actors change transform in one snapshot so a multi-select gizmo drag is one stack entry.

## Journal format

Path: `derived/{projectGuid}/journal/00000000.jsonl`, `00000001.jsonl`, … (app-private storage; see [containers.md](containers.md)). Lines are read in segment order. A project journalled by an older build may still have the single file `derived/{projectGuid}/journal.jsonl`; it is read first, and every clear removes both layouts.

Each line is one JSON object:

```json
{"v":1,"docId":"…","at":"ISO-8601","command":{"type":"…",…}}
```

- Append after successful edits, Undo and Redo on an open document. A multi-command history action is one `edit.batch` record with ordered child payloads, so concurrent actions cannot interleave its deltas. Legacy single-command lines still replay. An unsupported child skips the entire batch rather than applying only part of it.
- **Append cost is bounded.** `ProjectStorage` has no append operation, so `appendJournalLines` (`@babylonslate/assets`) reads and rewrites only the tail segment and starts a new segment once the tail would pass `JOURNAL_SEGMENT_MAX_CHARS` (64 KiB); a single longer record gets a segment of its own. A tail known to be too full for the next record is neither read nor rewritten, so large full-document records are each written once. The cost of an edit no longer grows with the unsaved session's length.
- **Batched writes.** The editor's `JournalBuffer` (`apps/editor/src/lib/journal-buffer.ts`) holds applied records per project and writes them in one append at most `JOURNAL_FLUSH_DELAY_MS` (150 ms) after the first. It also flushes when Save starts and again before Save clears the journal, before Discard journal, Close Project, recovery replay and document close (`afterFlush` runs each journal read or clear only once that project's buffered records are written), on `pagehide`, and when the app is hidden or backgrounded.
- **One record per gesture.** Consecutive buffered records of one continuous gesture (same document, command type, merge key and target) fold into one record carrying the first `from` and the last `to` (`coalesceJournalLines`). Only commands whose replay writes just `to` onto that target fold (`asset.setDocument`, `graph.moveNode`, `graph.setNodeData`, the scene transform / property / setting / rename commands), so recovering the folded record gives the same document; an asset scrub no longer serialises and writes its full payload on every pointer move. Replay rebuilds no undo history, so two separate edits of one target that land in the same batch may also fold. Asset edits without a merge key, batches and records for other targets or documents stay separate.
- **Crash-recovery window.** An edit reaches storage up to ~150 ms (plus the write itself) after it applies. A crash or killed tab inside that window loses those edits' recovery; everything earlier is on disk. `pagehide` and hide/background flushes narrow the window for ordinary reloads and app switches, but cannot guarantee the final write finishes.
- Clean **Close Project** and a successful **Save** truncate the journal (recovery is for _unsaved_ edits). Save captures the document revisions it writes; completion clears only matching revisions and retains later edits as dirty. A late older save marks a newer revision dirty again. Journal appends and clears are serialized per storage/project; Save checks that no newer dirty document or project settings exist before clearing recovery.
- Recovery banner in the editor shell (`data-testid="recovery-prompt"`) offers **Recover edits** / **Discard journal**. Replay opens missing target documents of any authored asset kind, including SceneLayer and Enum, then uses `replayJournalLines` → `reviveCommand` → `apply`. Only changed documents become dirty. Recovery keeps the journal until Save or clean Close, so another interrupted session does not lose the recovered edits. One stream is keyed by `docId`.
- Renaming or moving an open document appends a `document.repath` marker (`{"docId":"<new id>","command":{"type":"document.repath","from":"<old id>"}}`), not an edit command. `resolveJournalLines` gives earlier lines under `from` to the document's final id (chained renames resolve to the last one), so unsaved edits made before the rename and an Undo journalled after it replay together onto the moved file. Later lines under the old id belong to a document opened at that path afterwards and stay there. Recovery opens the resolved ids.
- Schema version `v` allows journal migration without inventing a parallel recovery path.

## Dirty / autosave

Interactive edits mark the document dirty on apply. `applyGraphChange` and `applySceneChange` both diff snapshots into commands, push through `EditSession`, then **immediately** bump chrome (Undo / Redo / Save All dirty) and schedule `saveProject` after `ProjectSettings.autoSaveIntervalMs` (default **120000**). The crash-journal record is buffered after that bump and written in a batch (see Journal format); a slow or failed journal write is logged and cannot leave Undo disabled. A second edit does **not** reset an already-running timer. **Save All** writes immediately, cancels the pending timer, then `flushSync`s the chrome bump so Save All disables in the same turn as `markAllClean`. **Play** is another explicit save trigger: if documents are dirty or graphs are compile-stale, Play saves and compiles first (progress dialog) and waits before launching Preview. When a save runs and `compileOnSave` is on (default **true**), open graphs compile. Only dirty documents write; large immutable chunks stay in the blob store (engineplan §19 / [vfs.md](vfs.md)).

Per-edit update cost: each applied edit bumps the document context once. Consumers that recompute on that bump keep their published values when nothing they depend on changed:

- `ValidationProvider.setDiagnostics` keeps the current list when a panel recomputes an equal one (Compiler Results for a scene, graph validation), so a selected diagnostic stays selected and its consumers do not re-render.
- `PrefabEditingProvider` (mounted for every Scene, Scene Layer and Class workspace) walks the registry and ancestor class graphs only for Class documents, keeps its components while the inherited ones are unchanged, and keys its parent lookup on the Class parents so an in-place reparent is picked up.
- `NavBakeProvider` registers its Save flush once per workspace and reads the latest documents through a ref.
- A quiet prefab sync on scene open writes through `DocumentService.patchLoadedContent`, so the scene's content revision advances like any other change.

Closing a dirty document tab (the tab **X**) opens the same Save / Discard / Cancel dialog used for Close Project; Cancel leaves the tab open. Discard drops the tab without writing. Save runs **Save All** then closes that tab. A `beforeunload` handler prompts the browser when any open document is dirty (refresh / leave). Autosave interval is unchanged.

## Document tab lifecycle

Chrome tabs, undo, and DockView hosts are three different lifetimes (engineplan §2.4, `p18-inactive-documents`):

| State | Chrome tab | `DocumentService` JSON + `EditSession` | DockView / Babylon / GraphEditor |
| --- | --- | --- | --- |
| **Open** | In the tab bar | Yes | Maybe |
| **Mounted-warm** | Open, and either active, Content Browser, an **open Scene**, or inactive inside the 2-minute grace (cap 3 non-CB; Scenes count) | Yes | Yes (`display: none` + P4 freeze if not active) |
| **Idle-unmounted** | Still in the tab bar | Yes — undo and dirty flags stay | No. Remount from `layout.json` + project-session camera / graph viewport + Anim mode |
| **Closed** | Gone | Dropped (`dropDocument`) | Gone; project-session camera / graph viewport / module cards stay for a reopen |

- Named constants (not Engine Settings): `DOCUMENT_IDLE_UNMOUNT_MS` = 120_000, `MAX_WARM_DOCUMENT_WORKSPACES` = 3.
- Pause the idle clock while the app is backgrounded.
- State Machine|Animation Object unmounts the **inactive mode** DockView immediately (no grace).
- Overlay Play **does not pin** Scene tabs. Open Scene documents stay mounted while the tab is open (they count toward the warm cap). The project owns the Engine on a hidden constructor canvas (`data-testid="project-engine-canvas"`); the Scene viewport is a `registerView` client. Closing the Scene tab (or exclusive one-Scene-tab replace) unmounts that Scene immediately and releases that handle's resource-cache leases (`bindResourceCacheToHandle` dispose); it does not dispose the project Engine. Overlay Play / Prefab / Material reuse `ensureSharedEngine`. Preview Build is an iframe and does not use that Engine.
- Closing a tab still tears down immediately (Save / Discard / Cancel unchanged).

## Scene apply path

`applySceneChange(id, next)` mirrors `applyGraphChange`: `diffSceneCommands(previous, next)` → `EditSession.applyBatch` → `updateScene` → `notifyDocumentEdited` (bump + scheduled save, then journal). Each document change is one history entry, including node deletion with incident edges and actor subtree deletion. Undo applies the inverse deltas in reverse order; indexed removals restore the original array order. A batch counts its combined byte cost against the history budget and journals its deltas together in one record. Empty batches leave history unchanged. Single-command edits retain their gesture merge keys. Undo/redo on scene tabs uses the same per-document stack as graphs and schedules autosave through the same notification path. The pipeline preserves object identity for untouched actors: `stampUserComponentOverrides` and `copyInstanceLinkage` return the original actor and component objects when their `sourceId` and override keys are unchanged, and `diffSceneCommands` skips field and component diffs for identical references (still checking reorder) with O(1) index maps instead of per-actor `findIndex`, so one edit yields only that actor's deltas and other actor references stay stable for memoized panels.

Outliner folder edits use the same path: `scene.addFolder` / `scene.removeFolder` / `scene.renameFolder` / `scene.reparentFolder` group rows, and `scene.setActorFolder` moves an actor between folders without touching `parentId`. `journal.test.ts` asserts every `SCENE_COMMAND_TYPES` entry has a reviver, so a new scene command cannot ship unreplayable.

See [scene-editing.md](scene-editing.md) for viewport/outliner wiring.

## Tests

Every command type gets an apply-then-invert property test asserting structural equality of the document model. Stack tests cover merge keys, dual budgets, and active-document scoping. Playwright `e2e/p2-accept.spec.ts` covers killed-tab journal recovery; `e2e/p6-scene-editing.spec.ts` covers scene undo through the command layer; `e2e/p5-scripting.spec.ts` covers Class graph undo/redo on the canvas; `e2e/p18-editor-opt.spec.ts` covers idle-unmount (2-minute grace, cap 3 including the open Scene, overlay Play **through** idle grace without resetting Tick) plus Prefab/Play sharing the project-lifetime Engine.
