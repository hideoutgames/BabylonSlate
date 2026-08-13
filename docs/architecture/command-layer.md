# Command layer

Shared surface for P2 undo, dirty saves, and crash recovery (engineplan §§7.3, 2.4, 16.1). Implementation lives in `@babylonslate/edit`.

## Package API (`@babylonslate/edit`)

| Export | Role |
| --- | --- |
| `EditCommand` | Reversible mutation contract (`apply`, `invert`, optional `mergeKey` / `byteSize`) |
| `DocumentEditStack` | Per-document undo/redo stack with entry + byte budgets |
| `EditSession` | Map of `docId → DocumentEditStack`; `apply` / `undo` / `redo` / `dropDocument` |
| `diffGraphCommands` | Derives graph commands from before/after `SerializedGraph` snapshots |
| `MoveNodeCommand`, `AddEdgeCommand`, `RemoveEdgeCommand`, `SetNodeDataCommand`, `SetGraphMembersCommand`, `SetGraphComponentsCommand` | Graph document commands |
| `AddActorCommand`, `RemoveActorCommand`, `SetActorTransformCommand`, `RenameActorCommand`, `ReparentActorCommand`, `ReorderActorCommand`, `SetActorFlagsCommand`, `AddComponentCommand`, `RemoveComponentCommand`, `ReorderComponentCommand`, `SetComponentPropertyCommand`, `SetSceneSettingCommand`, `SetViewportModeCommand` | Scene document commands |
| `SetAssetDocumentCommand` | Asset-tab payload replace; optional `mergeKey` for paint strokes |
| `diffSceneCommands` | Derives scene commands from before/after `SerializedScene` snapshots |
| `serializeJournalLine` / `parseJournalLine` | JSONL journal line codec |
| `replayJournalLines` | Replay journal onto open graph or scene documents |
| `reviveCommand` / `registerCommandReviver` | Registry to rebuild commands from journal JSON |

Editor wiring: `DocumentProvider` owns an `EditSession` configured with `DEFAULT_EDIT_BYTE_BUDGET` plus Engine Settings `undoHistoryLength`; graph panels call `applyGraphChange`, scene panels call `applySceneChange`, asset tabs call `applyAssetDocumentChange`; chrome **Undo** / **Redo** act on the active document only. `SetNodeDataCommand` and subtree-capturing scene commands (e.g. `RemoveActorCommand`) record `byteSize` so snapshot-style edits count toward the budget. Tilemap paint strokes pass `SetAssetDocumentCommand.mergeKey` (`tilemap-stroke:<id>`) so one undo restores the whole gesture.

## Ownership

| Concern | Owner |
| --- | --- |
| In-document mutations (graph, scene, properties) | `packages/edit` command stream |
| Asset **file** create / delete / folder ops | Asset registry (`packages/assets`) — **outside** undo |
| Persisting dirty documents | Editor services, triggered after command apply (`autoSaveIntervalMs`) |
| Journal (crash recovery) | Derived-data JSONL of the **same** command stream |

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
- Chrome undo/redo act on the **active** document only; buttons are the primary touch affordance (keyboard shortcuts secondary on desktop).
- Caps (both enforced; drop from the oldest end when either is exceeded):
  - **Entry limit** from Engine Settings `undoHistoryLength` (default 50).
  - **Byte budget** across recorded `byteSize` values (snapshot fallbacks).

Merge: if the new command’s `mergeKey` equals the top undo entry’s key, replace the top entry with a coalesced command (one undo step per gesture).

## Journal format

Path: `derived/{projectGuid}/journal.jsonl` (app-private storage; see [containers.md](containers.md)).

Each line is one JSON object:

```json
{"v":1,"docId":"…","at":"ISO-8601","command":{"type":"…",…}}
```

- Append after a successful `apply` on an open document (`appendJournalLine` in derived data).
- Clean **Close Project** and a successful **Save** truncate the journal (recovery is for *unsaved* edits).
- Recovery banner in the editor shell (`data-testid="recovery-prompt"`) offers **Recover edits** / **Discard journal**. Replay opens any missing journal target documents (graphs and scenes), then `replayJournalLines` → `reviveCommand` → `apply`, then truncates. One stream keyed by `docId` — not a parallel recovery path per document kind.
- Schema version `v` allows journal migration without inventing a parallel recovery path.

## Dirty / autosave

Interactive edits mark the document dirty on apply. `applyGraphChange` and `applySceneChange` both diff snapshots into commands, push through `EditSession`, append journal lines, and schedule `saveProject` after `ProjectSettings.autoSaveIntervalMs` (default **120000**). A second edit does **not** reset an already-running timer. **Save All** writes immediately and cancels the pending timer. **Play** is another explicit save trigger: if documents are dirty or graphs are compile-stale, Play saves and compiles first (progress dialog) and waits before launching Preview. When a save runs and `compileOnSave` is on (default **true**), open graphs compile. Only dirty documents write; large immutable chunks stay in the blob store (engineplan §19 / [vfs.md](vfs.md)).

## Scene apply path

`applySceneChange(id, next)` mirrors `applyGraphChange`: `diffSceneCommands(previous, next)` → sequential `EditSession.apply` → `updateScene` → journal append → scheduled save. Undo/redo on scene tabs uses the same per-document stack as graphs.

See [scene-editing.md](scene-editing.md) for viewport/outliner wiring.

## Tests

Every command type gets an apply-then-invert property test asserting structural equality of the document model. Stack tests cover merge keys, dual budgets, and active-document scoping. Playwright `e2e/p2-accept.spec.ts` covers killed-tab journal recovery; `e2e/p6-scene-editing.spec.ts` covers scene undo through the command layer.
