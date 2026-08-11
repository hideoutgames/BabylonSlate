# Command layer

Shared surface for P2 undo, dirty saves, and crash recovery (engineplan §§7.3, 2.4, 16.1). Implementation lives in `@babylonslate/edit`.

## Package API (`@babylonslate/edit`)

| Export | Role |
| --- | --- |
| `EditCommand` | Reversible mutation contract (`apply`, `invert`, optional `mergeKey` / `byteSize`) |
| `DocumentEditStack` | Per-document undo/redo stack with entry + byte budgets |
| `EditSession` | Map of `docId → DocumentEditStack`; `apply` / `undo` / `redo` / `dropDocument` |
| `diffGraphCommands` | Derives graph commands from before/after `SerializedGraph` snapshots |
| `MoveNodeCommand`, `AddEdgeCommand`, `RemoveEdgeCommand`, `SetNodeDataCommand` | Graph document commands |
| `serializeJournalLine` / `parseJournalLine` | JSONL journal line codec |
| `reviveCommand` / `registerCommandReviver` | Registry to rebuild commands from journal JSON |

Editor wiring: `DocumentProvider` owns an `EditSession`; graph panels call `applyGraphChange`; chrome **Undo** / **Redo** act on the active document only.

## Ownership

| Concern | Owner |
| --- | --- |
| In-document mutations (graph, scene, properties) | `packages/edit` command stream |
| Asset **file** create / delete / folder ops | Asset registry (`packages/assets`) — **outside** undo |
| Persisting dirty documents | Editor services, triggered after command apply (debounced) |
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

- Append after a successful `apply` on an open document.
- Clean **Close Project** truncates the journal.
- Recovery reopens the project, then replays lines through the same `apply` path (no second serialisation format).
- Schema version `v` allows journal migration without inventing a parallel recovery path.

## Dirty / debounce saves

Interactive edits mark the document dirty on apply. Save batches are **debounced** behind the command layer (engineplan §19 / [vfs.md](vfs.md)): only dirty documents write; large immutable chunks stay in the blob store.

## Tests

Every command type gets an apply-then-invert property test asserting structural equality of the document model. Stack tests cover merge keys, dual budgets, and active-document scoping.
