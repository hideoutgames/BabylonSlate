# Save Games

Typed Save Game definitions, the save/load service shared by Play, Preview Build and the exported player, actor-state capture, migrations, and per-host storage.

## Decisions

- Save Games persist selected gameplay data **independently of project files**. A project selects one definition (`ProjectSettings.saveGame.definitionGuid`); scripts use one service in editor Play, Preview Build and the exported web player.
- Saves never serialize Babylon scenes, GPU resources, JavaScript closures, active timers or engine subsystems. Only definition fields and explicitly selected actor/component state persist.
- Every async operation returns `{ ok: true, value }` or `{ ok: false, error: { code, message } }`; storage failure never silently switches to temporary memory.
- Two alternating checksummed generations per slot; never overwrite the sole valid generation. Missing, corrupt and incompatible are distinct outcomes, and a newer incompatible save is never silently downgraded to an older generation.
- New Game is not consent to discard data: damaged or incompatible slots need an explicit delete. App exit and backgrounding are not reliable points to finish an async write.
- Actor persistence targets the active **main world scene** only. Streamed scenes and SceneLayers are excluded until their instance identities give a stable contract; store cross-scene progress in definition fields.
- The exporter produces only a web player; native host adapters host the editor and do not imply native exported games.

## Ownership

| Area | Source |
| --- | --- |
| Definition, field types, error codes, value validation, `generateSaveGameTypes` | [`packages/core/src/save-game.ts`](../../../packages/core/src/save-game.ts) |
| `SaveGameService` (generations, checksums, migrations, namespaces) | [`save-game-service.ts`](../../../packages/core/src/save-game-service.ts) |
| Storage RPC (worker / Preview iframe ↔ host) | [`save-game-rpc.ts`](../../../packages/core/src/save-game-rpc.ts), [`packages/exporter/src/preview-save-storage.ts`](../../../packages/exporter/src/preview-save-storage.ts) |
| Disposable Simulation overlay | [`session-save-storage.ts`](../../../packages/core/src/session-save-storage.ts) |
| Actor/component capture, staging, apply | [`packages/runtime/src/save-game-world.ts`](../../../packages/runtime/src/save-game-world.ts) |
| Script API (`ctx.saveGame`, …) | [`packages/runtime/src/script-host.ts`](../../../packages/runtime/src/script-host.ts) |
| Host adapters (OPFS, Web Locks, Electron, Capacitor, Node) | [`packages/vfs/src/`](../../../packages/vfs/src/) `save-game-*.ts` |
| Desktop IPC owner | [`apps/desktop/src/desktop-save-games.ts`](../../../apps/desktop/src/desktop-save-games.ts) |
| Definition editor, typed nodes, save manager | [`apps/editor/src/`](../../../apps/editor/src/) `panels/save-game-panels.tsx`, `lib/save-game-catalog.ts`, `components/project-save-games-settings.tsx` |

## Definitions

- Asset type `SaveGame`, `.savegame.babasset`. Field types: `bool`, `int`, `float`, `string`, `vector3`, `actor`, `asset`, and arrays of those. Actor and Asset values persist stable ids or `null`. Map fields are not definition types.
- Each field has an immutable internal id separate from its editable name: renaming keeps existing saves; delete-and-add creates a different field. Raw ids are not shown in authoring controls. Added fields take their defaults when an older save loads.
- `schemaVersion` describes gameplay data and is separate from the save file format version and the project release version.
- The default definition generates **Get/Set Save _Field_** nodes keyed by field id, and a `SaveData` interface (`generateSaveGameTypes`) for code tooling. JavaScript reads fields by name, so renames need code updates.
- Project defaults: `defaultProfile` and `defaultSlot` (`default`), `wipeOnPlay` (editor previews only).

## Service

- Operations: Get Save Data, New Game, Save Game, Load Game, List Saves, Delete Save (graph nodes and `ctx.*`). Empty Slot/Profile select the project defaults.

| Code | Meaning |
| --- | --- |
| `missing` | No save in that profile/slot |
| `corrupt` | Stored generations failed validation; preserve them |
| `incompatible` | Definition, schema or format not loadable by this build |
| `storage-full` | Write rejected for capacity; previous generation remains |
| `unavailable` | Storage backend unusable |
| `invalid` | Request or gameplay value invalid |
| `apply-failed` | Validated data could not be restored to the runtime |

- Namespace: `save-games/<projectId>/<preview|game>/<profile>/<slot>`, keyed by the stable project id so renames never change save identity. Editor previews and exported players never share a namespace; Reset only works on preview saves.
- Capture runs at the runtime simulation boundary (`atBoundary`); encoding, hashing and storage run afterwards. Async completion is not zero frame cost.
- Conflicting operations are serialized; on web, Web Locks cover the full read/choose/write transaction across same-origin tabs. Native hosts need equivalent host-owned coordination.
- Loads validate format, definition, schema, field values and runtime state before applying; a failed load never replaces the current data. New Game and Load replace contents but keep the identity of the record from Get Save Data.
- `ctx` members can be destructured but must not be enumerated or spread: the host shares most members through its prototype.

## Gameplay state

- **Save Game** component selects actor transforms, actor/script variables and component variables (inherited ones included). Each save captures the selection at that moment.
- Spawned actors must be registered with stable identities (`ctx.registerSaveActor(actor, persistentId)` before first capture). A restored spawned actor takes its persistent id as its guid; ids already used by a live actor are rejected.
- Transform saves include stable parent references; missing or cyclic parents reject the load. Actor references resolve after actors are restored and before **On Game Loaded**.
- Selected variables support nested Maps with string or finite-number keys (kept distinct). Cycles, unsupported keys or malformed Map data reject the operation without replacing the checkpoint.

## Migrations

- Migrations receive a detached document (`schemaVersion`, `fields` keyed by field id, optional `state`) and upgrade exactly one version; they may mutate or return a replacement, sync or async. Register them before loading (Register Save Migration / `ctx.registerSaveMigration`).
- They run on a validated copy; failure leaves stored generations intact. Loading a migrated save never rewrites its source; the first save after an upgrade archives the original (`original-v<n>-…`), kept until explicit delete.
- If any custom migration applies, every intermediate version must be registered (no-ops allowed); an incomplete chain rejects load and save. Without custom migrations, added defaults and id-stable renames upgrade automatically. Actor fields are persistent-id strings during migration.
- Inspection in the editor never runs game scripts or custom migrations.

## Storage hosts

| Host | Location |
| --- | --- |
| Web editor and exported web player | OPFS (`babylonslate-game-saves`), separate preview/game namespaces; subject to quota, eviction and user deletion |
| Electron editor | Dedicated subdirectory of `userData`, through desktop IPC |
| Capacitor editor | iOS `Library/Application Support`, Android internal files. Capacitor Filesystem removes the destination before moving, so the adapter replaces only the inactive generation and claims no atomic rename |

- Preview Build forwards storage requests to the editor host through a scoped bridge, sharing Overlay Play's preview slots and reset controls.
- `createSessionSaveStorage` is the boundary for disposable Simulation sessions: untouched keys read through to the Preview namespace without copying; writes and deletes stay in a bounded local overlay dropped on dispose. It never writes the backing adapter or requests persistence. Its byte budget counts UTF-16 key/value data, not heap.
- **Request Persistent Storage** only asks the browser to reduce eviction; export saves that need an independent backup. Import validates before committing as a new generation.
