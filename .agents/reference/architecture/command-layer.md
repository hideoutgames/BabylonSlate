# Command Layer

Undo/redo, dirty state, autosave and the crash-recovery journal for authored documents, plus the editor document pipeline that drives them.

## Ownership

| Concern | Owner |
| --- | --- |
| In-document mutations (graph, scene, asset payloads) | [`packages/edit/src/`](../../../packages/edit/src/) commands through `EditSession` |
| Asset file create / delete / move / folder ops | Asset registry ([asset-registry](asset-registry.md)), **outside** undo |
| Edit pipeline, Undo/Redo, journal append/replay, prefab sync | `DocumentEditingService` ([`apps/editor/src/services/document-editing-service.ts`](../../../apps/editor/src/services/document-editing-service.ts)) |
| `EditSession` lifecycle, gesture boundaries, recovery banner, rename | `DocumentProvider` ([`apps/editor/src/context/document-context.tsx`](../../../apps/editor/src/context/document-context.tsx)) |
| Open documents, revisions, dirty baselines | `DocumentService` ([`apps/editor/src/services/document-service.ts`](../../../apps/editor/src/services/document-service.ts)) |
| Play/export content collection and compile cache | `createPlayContentService` ([`play-content-service.ts`](../../../apps/editor/src/services/play-content-service.ts)) |
| Journal batching | `JournalBuffer` ([`apps/editor/src/lib/journal-buffer.ts`](../../../apps/editor/src/lib/journal-buffer.ts)); segments via `appendJournalLines` ([`packages/assets/src/derived-data.ts`](../../../packages/assets/src/derived-data.ts)) |

The undo boundary is exactly the asset-file boundary. Editing surfaces never mutate document models directly; every accepted edit goes through `applyGraphChange` / `applySceneChange` / `applyAssetDocumentChange`. The only Scene write without a command is the open-time prefab sync.

## Command contract

```ts
interface EditCommand<TDoc = unknown> {
  readonly type: string;
  readonly mergeKey?: string;          // coalesce one continuous gesture
  apply(doc: TDoc): TDoc;              // pure replacement; never mutate input
  invert(): EditCommand<TDoc>;
  coalesce?(next: EditCommand<TDoc>): EditCommand<TDoc> | undefined; // first `from`, last `to`
  readonly byteSize?: number;          // snapshot cost, measured lazily
}
```

- Prefer deltas; snapshot a subtree only when a compact inverse is impractical, and report `byteSize`.
- Commands are serialisable (`type` + fields) for the journal. Every `SCENE_COMMAND_TYPES` entry needs a reviver (`journal.test.ts` enforces it).
- Commands copy what they add or set (independent snapshots), and `apply` returning its input means no-op (`history: "unchanged"`; Redo kept). Reorders move only from the recorded `from` index.
- `diffSceneCommands` / `diffGraphCommands` derive commands from before/after snapshots. `planSceneChange` replays the deltas and falls back to one `ReplaceSceneCommand` when they do not reproduce the target (safety net for fields without a delta).
- `ReplaceSceneCommand` rejects values JSON would lose (undefined, non-finite, `-0`, sparse arrays, runtime objects, cycles).

## Stacks and budgets

- One `DocumentEditStack` per document id, never a global stack. Chrome Undo/Redo act on the active document only.
- `HistoryOutcome`: `recorded` | `cleared` (edit larger than the budget still applies, history is cleared) | `cleared-gesture` (rest of that gesture) | `unchanged`.
- Caps from Engine Settings ([`packages/vfs/src/app-settings.ts`](../../../packages/vfs/src/app-settings.ts)): `undoHistoryLength` default 50 (1–1000); `undoByteBudget` default 16 MiB (1–1024 MiB). Oldest entries drop first; `EditSession.configure` reapplies to all stacks.
- `applyWithHistoryAdmission`: both directions must declare finite integer byte costs that fit before `apply` runs; otherwise `history-budget` / `invalid-byte-size` with nothing changed. Used by Simulation Keep ("Apply Simulation Changes").
- Merge: equal `mergeKey` on the top entry coalesces. Keys: `move:<nodeId>`, `data:<nodeId>`, `function-graph:<name>`; multi-actor transforms become one `SetActorsTransformsCommand`. Hosts pass stable per-field keys for scrubs; gesture boundaries (new pointer gesture, Enter, blur, discrete key) end a merge group.
- History outlives the tab for the project session: a clean close keeps it with a `documentContentIdentity` hash; reopen resumes only when the content identity matches. Discarded edits, deleted paths, external changes and project open/close drop history. Renames move history with `EditSession.rekeyDocument`; a stack already under the new id is dropped, never inherited.

## Dirty state and saving

- Forward edits mark dirty without hashing. Undo, Redo and journal replay compare against the last saved/loaded baseline (Scenes structurally, others by content identity), so undoing to saved content is clean.
- Autosave runs `ProjectSettings.autoSaveIntervalMs` (default 120000) after the first edit; later edits do not reset the timer. Failures keep documents dirty. `compileOnSave` defaults true. Play is an explicit save + compile trigger.
- Only dirty documents write. Queued writes resolve the asset's current path from its guid, so a queued save cannot resurrect a moved or deleted path.
- `lockAuthoringWrites(reason)` closes project-write admission (Save All, autosave, registry, blob, extension writes) and its lease's `ready` resolves after admitted operations drain. Simulation preparation takes its baseline behind it.

## Journal format

- Path: `derived/{projectGuid}/journal/00000000.jsonl`, `00000001.jsonl`, … in app-private derived storage. Segments roll at `JOURNAL_SEGMENT_MAX_CHARS` = 64 KiB (append rewrites only the tail segment).
- Line: `{"v":1,"docId":"…","at":"ISO-8601","command":{"type":"…",…}}`. Multi-command actions are one `edit.batch` record; an unsupported child skips the whole batch.
- Markers: `document.repath` (`docId` = new id, `from` = old id; `resolveJournalLines` follows chains), `document.discard` (close drops earlier edits), `document.checkpoint` (Class rename snapshot of open referrers).
- `JournalBuffer` writes at most `JOURNAL_FLUSH_DELAY_MS` = 150 ms after the first record, and flushes on Save, close, `pagehide` and backgrounding. Edits inside that window can be lost on a crash.
- `coalesceJournalLines` folds one gesture (first `from`, last `to`) only for commands whose replay writes just `to`. `byteSize` never enters journal payloads.
- Replay: `replayJournalLines` → `reviveCommand` → `apply`. Malformed lines return in `malformed`, throwing records in `skipped`; neither is dropped until Save or clean close.
- Successful Save and clean Close Project truncate the journal (only revisions the save wrote). Project Settings are not journaled. `v` exists for future journal migration.

## Document revisions and subscriptions

- Documents mutate in place; `DocumentService.getRevisions()` keeps one revision per document kind plus `tabsRevision`, drawn from one service-wide sequence.
- Components read the narrowest hook: `useDocumentActions()` (stable for the provider lifetime), `useOpenDocument(id)`, `useDocumentDirty(id)`, `useOpenDocumentsOfKinds(kinds)`, `useOpenDocumentTabs()`, `useRegistryState()`, `useSaveState()`. `useDocuments()` is deprecated.
- Memos that read the registry key on `[assetRegistry, registryEpoch]`; memos that read other open documents key on `useOpenDocumentsOfKinds`. Edits never advance `registryEpoch`.
- Code that runs after render (handlers, async work) reads `getOpenDocuments()` at call time, never a render snapshot.

## Document tab lifecycle

| State | Tab | Content + history | DockView / Babylon |
| --- | --- | --- | --- |
| Mounted-warm | Open | Yes | Yes (hidden + frozen when inactive) |
| Idle-unmounted | Open | Yes | No; remount from `layout.json` + session view state |
| Closed | Gone | Clean history kept for same-content reopen | Gone |

- `DOCUMENT_IDLE_UNMOUNT_MS` = 120_000, `MAX_WARM_DOCUMENT_WORKSPACES` = 3 ([`document-working-set.ts`](../../../apps/editor/src/lib/document-working-set.ts)); named constants, not settings. Open Scenes stay mounted and count toward the cap.
- The project owns one Engine on a hidden canvas; viewports are `registerView` clients. Closing a Scene tab releases its leases but never disposes the project Engine. Closing or replacing the Scene a Play/Simulate/Preview session started from stops that session first.
