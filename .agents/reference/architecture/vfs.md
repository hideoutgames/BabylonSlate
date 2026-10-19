# VFS And App Settings

Storage port, platform adapters, app-owned libraries, Engine Settings storage, secrets and native HTTP.

## Ownership and boundaries

- Port: `ProjectStorage` in [`packages/core/src/storage-port.ts`](../../../packages/core/src/storage-port.ts). Adapters and factories: [`packages/vfs/src/`](../../../packages/vfs/src/) (`createStorage`, `createMountedProjectStorage`, `createReadOnlyProjectStorage`, `createTemplateStorage`, `createDerivedStorage`, `createAppSettingsStore`, `createSaveGameStorage`).
- **The UI never imports Capacitor or Electron.** All project I/O goes through `createStorage()`; secrets and CORS-bypass HTTP stay in `vfs` so they never leak into `@babylonslate/source-control` or the editor.
- Desktop main process and preload: [`apps/desktop/src/`](../../../apps/desktop/src/). Native plugins: `apps/editor/ios/App/App/`, `apps/editor/android/app/src/main/java/`.

## ProjectStorage contract

- Methods: `pickProjectFolder` / `openDocumentsProject` / `openKnownFolder` / `listProjects` / `getCurrentFolder` / `releaseFolder`; `readText` / `writeText` / `readBinary` / `writeBinary` / `readBinaryRange`; `exists` / `readdir` / `mkdir` / `remove` / `stat`; optional `deleteProject`, `withReadScope`, `getReadMetrics`, `hasStrongSourceRevisions`.
- `""` and `"."` name the project root; `..` segments are rejected on every adapter.
- `deleteProject` exists only on OPFS and memory, so Homepage list-remove can never trash native folders.
- **Errors:** a missing path rejects with `StorageNotFoundError` (`code: "not-found"`); test with `isStorageNotFound(error)`, never by message. `exists()` returns `false` only for not-found; permission, I/O, quota, stale-handle and path-escape failures reject. `remove()` of a missing path rejects.
- **Bounded reads:** `readBinaryRange(path, offset, length, expectedRevision?, options?)` returns exact bytes plus size and an opaque revision; short reads and changed revisions reject (`SourceRevisionChangedError`). Never implement a range by slicing a full read. Native bridges cap one transfer at 512 MiB.
- Revisions detect change; they are not transactions. `hasStrongSourceRevisions` is true only for owned memory generations and immutable HTTP catalogs; disk adapters leave it unset, so asset readers refresh headers and fold the header digest into the logical revision.
- `StorageReadOptions.signal` is forwarded through mounted/read-only views; the last interested owner aborts shared transport. Cancellation does not release reservations before the read settles.
- `createMountedProjectStorage` overlays read-only views (most specific path wins) without copying payloads.

## Adapters

| Adapter | Host | Notes |
| --- | --- | --- |
| OPFS | Web | Projects in `project-v2-<SHA-256 hex of JSON id>`; binding/deletion serialize with Web Locks, and a bound project holds a per-project session lock (one tab per project, below); writes never recreate a deleted project folder; `readdir` skips `*.crswap`; required for browser writes (no temporary in-memory saves). Libraries/derived data bind with `{ library: true }`. |
| Documents | iPad / Android default | `Directory.Documents` (iOS) or app-private `Directory.Data` (Android) under `BabylonSlate/projects/`; no picker. Android projects excluded from cloud backup. |
| Scoped / external | iPad / Android opt-in | Security-scoped bookmarks (`NSFileCoordinator`) / SAF tree URIs; root-confined paths; revoked access → **Reconnect Project Folder**. iOS resolves each bookmark once per session and holds its access: every resolution issues a sandbox extension and iOS caps them per process, so resolving per operation exhausted them and failed later folders until relaunch. SAF overwrites stage a sibling then rename. |
| Node | Electron main, tools | Root-confined through real paths; writes stage `.babylonslate-<uuid>.tmp`, flush and rename (no truncated files). |
| Electron | Desktop renderer | `ElectronStorageAdapter` over `project:*` IPC; one main-process Node adapter per editor document; project ids are `node:` paths under `userData/projects`. |
| HTTP catalog | Bundled engine plugins | `HttpCatalogStorageAdapter` over content-addressed immutable parts; never downloads archives; works without HTTP Range. |
| Read-only wrapper / Memory | Engine plugins / tests | Writes throw / in-memory tree. |

- **OPFS session lock:** a project (non-library) bind holds the Web Lock `babylonslate:opfs-session:<project id>` until `releaseFolder`, a bind of another project, or deleting that project. It is separate from the `babylonslate:opfs:<id>` lifecycle lock, which only covers a bind or delete. A project is therefore open in one tab; the journal and saves have a single writer. Refusal is taken with `ifAvailable` and throws `ProjectOpenElsewhereError` (`isProjectOpenElsewhere`) before any folder, meta or bound-project change, so the previous project stays bound. `deleteProject` needs the lock too (its own session counts); it borrows it for the deletion otherwise. Libraries take none. Locks die with their document, so reload and crash free the project, and the lock is released (and awaited) before the folder is reported released so a same-tab reopen is never refused. A host without `navigator.locks` cannot tell, so it does not refuse. Other adapters are single-window and unaffected.
- `withReadScope` gives a scan a bounded native directory-lookup cache (Android): ≤ 8,192 listing entries per scope, ≤ 8 scopes per plugin, cleared around every mutation. Not a snapshot.
- Mobile startup restores external folder ids without contacting the provider; recents reopen by stable id and never recreate missing folders.

## App-owned libraries and derived data

- `LIBRARY_FOLDERS` ([`library-folders.ts`](../../../packages/vfs/src/library-folders.ts)) is exactly `__slate_templates__`, `__slate_engine_plugins__`, `__slate_engine_extensions__`; renderer and Electron main share it. Electron binds each to `userData/libraries/<folder>` over `library:*` IPC (file operations only: no picker, open, list or release channels) and refuses any other scope.
- Derived data: `createDerivedStorage` root `__babylonslate_derived__` (OPFS library bind on web/Electron, beside projects on mobile). It is a regenerable cache.
- Templates: each directory with `project.json` or `.zip` in the template library is a card; only the chosen template is decoded. No user-chosen templates folder.

## Project creation

- Scaffold only into an empty folder (ignoring `.babylonslate-creating`, `.DS_Store`, `Thumbs.db`, `desktop.ini`); never overwrite. `.babylonslate-creating` marks an app-owned partial scaffold that a retry may clear.
- Persist the recent-project entry before the editor becomes interactive. Project identity for the browser lives in `project.json` metadata (`name`, optional `appearance`; uploaded images ≤ 96 KiB data URL).

## Write performance decision

The Documents tier crosses the Capacitor bridge once per asset write with base64 encoding, so: (1) write only dirty documents, (2) externalise large immutable chunks to the blob store (existing hashes are never rewritten), (3) debounce behind the command layer. **No pack format**: one `.babasset` per asset stays the on-disk unit, keeping the registry and Content Browser free of pack indirection. Revisit only with device numbers.

## App settings (Engine Settings)

- Global settings live outside any project; schema and defaults in [`app-settings.ts`](../../../packages/vfs/src/app-settings.ts). Backends: Capacitor Preferences (iOS/Android), `globalThis.babylonslate.userData` (Electron, `engine-settings.json` replaced atomically), localStorage (web).
- `AppSettingsStore.update` is a queued read-mutate-validate-write transaction across store instances; emit change events only after persistence.
- A refused save keeps settings in memory for the session; an unreadable file keeps `automaticUpdatesEnabled` off (it may hold an opt-out). A failed native Preferences read never overwrites stored settings.
- `appearance.theme` and `appearance.coarsePointerTargetScale` stay in the schema for stored files, but nothing reads them and Engine Settings does not show them (the editor is dark only).
- Number settings clamp on load (for example `undoHistoryLength` 1–1000, `traceByteBudget` 1–256 MiB, default 128 MiB).

## Secrets and native HTTP

- `SecretStore { available, get, set, delete }`; source-control key `source-control:{projectGuid}`. Never in Capacitor Preferences or `project.json`.

| Host | SecretStore | `nativeHttp` |
| --- | --- | --- |
| iOS | `BabylonSlateSecrets` Keychain plugin (App target, `packageClassList`) | `CapacitorHttp` |
| Android | `BabylonSlateSecrets` AndroidKeyStore AES-GCM, excluded from backup | `CapacitorHttp` |
| Electron | `secrets:get/set/delete` IPC → versioned file, atomic owner-only writes, values tagged `safeStorage` or plaintext; read failures reject, never reset | `lfs:fetch` → `net.fetch`, bodies ≤ 16 MiB, no redirects or cookies |
| Web | `UnavailableSecretStore` (`available: false`): Source Control hidden | none |

- `nativeHttp`: `{ method, url, headers, body?, upload? }` → `{ status, bodyText, headers? }`. `upload` is one base64 image (PNG, JPEG, GIF or WEBP) sent as a `multipart/form-data` POST instead of `body`; the transport owns the encoding and `Content-Type` (Capacitor `formData` entries, or Electron's main process), see [accounts](accounts.md#account-management). Account tokens on Electron use a separate `accountSecrets` bridge.
- Preload exposes `babylonslate.userData`, `.project`, `.library`, `.secrets`, `.accountSecrets`, `.saveGames`, `.http`.

## Platform decisions

- iOS WebContent process termination is handled by Capacitor's native reload; there is no app-level hook and we do not replace its private delegate. Journaled edits recover on reopen; Play and bakes never restart automatically.
- `StatusBarStylePort` only sets glyph style; never hide or overlay the native status bar.
- Android audio lifecycle never requests audio focus. iOS uses a `.playback` session mixed with other apps.
- Gameplay saves never live in project folders ([save-games](save-games.md)).
