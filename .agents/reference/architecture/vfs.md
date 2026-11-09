# VFS And App Settings

Storage port, platform adapters, app-owned libraries, Engine Settings storage, secrets and native HTTP.

## Ownership and boundaries

- Port: `ProjectStorage` in [`packages/core/src/storage-port.ts`](../../../packages/core/src/storage-port.ts). Adapters and factories: [`packages/vfs/src/`](../../../packages/vfs/src/) (`createStorage`, `createMountedProjectStorage`, `createReadOnlyProjectStorage`, `createTemplateStorage`, `createDerivedStorage`, `createAppSettingsStore`, `createSaveGameStorage`).
- **The UI never imports Capacitor or Electron.** All project I/O goes through `createStorage()`; secrets and CORS-bypass HTTP stay in `vfs` so they never leak into `@haptic/source-control` or the editor.
- Desktop main process and preload: [`apps/desktop/src/`](../../../apps/desktop/src/). Native plugins: `apps/editor/ios/App/App/`, `apps/editor/android/app/src/main/java/`.

## ProjectStorage contract

- Methods: `pickProjectFolder` / `openDocumentsProject` / `openKnownFolder` / `listProjects` / `getCurrentFolder` / `releaseFolder`; `readText` / `writeText` / `readBinary` / `writeBinary` / `readBinaryRange`; `exists` / `readdir` / `mkdir` / `remove` / `stat`; optional `deleteProject`, `withReadScope`, `getReadMetrics`, `hasStrongSourceRevisions`.
- `""` and `"."` name the project root; `..` segments are rejected on every adapter.
- `deleteProject` permanently deletes a project in app storage: OPFS, mobile Documents (refusing the library and derived-data folders that share its root, `isAppOwnedFolder`), and Node/Electron, which accepts only a folder directly in the Projects Folder, never a picked one. Chosen (`external`) folders are refused, so Homepage removal only drops their recent (`removeDeletesProject`). Desktop main also refuses a project another window has open, since it has no cross-window lock.
- **Errors:** a missing path rejects with `StorageNotFoundError` (`code: "not-found"`); test with `isStorageNotFound(error)`, never by message. `exists()` returns `false` only for not-found; permission, I/O, quota, stale-handle and path-escape failures reject. `remove()` of a missing path rejects.
- **Bounded reads:** `readBinaryRange(path, offset, length, expectedRevision?, options?)` returns exact bytes plus size and an opaque revision; short reads and changed revisions reject (`SourceRevisionChangedError`). Never implement a range by slicing a full read. Native bridges cap one transfer at 512 MiB.
- Revisions detect change; they are not transactions. `hasStrongSourceRevisions` is true only for owned memory generations and immutable HTTP catalogs; disk adapters leave it unset, so asset readers refresh headers and fold the header digest into the logical revision.
- `StorageReadOptions.signal` is forwarded through mounted/read-only views; the last interested owner aborts shared transport. Cancellation does not release reservations before the read settles.
- `createMountedProjectStorage` overlays read-only views (most specific path wins) without copying payloads.

## Adapters

| Adapter | Host | Notes |
| --- | --- | --- |
| OPFS | Web | Projects in `project-v2-<SHA-256 hex of JSON id>`; binding/deletion serialize with Web Locks, and a bound project holds a per-project session lock (one tab per project, below); writes never recreate a deleted project folder; `readdir` skips `*.crswap`; range revisions combine `lastModified`, size and a write counter that tells same-millisecond rewrites apart, drawn from one never-reused sequence so a successful `remove` or `deleteProject` can drop a removed path's counter (a failed one keeps it, so unchanged bytes keep their revision); required for browser writes (no temporary in-memory saves). Libraries/derived data bind with `{ library: true }`. |
| Documents | iPad / Android default | `Directory.Documents` (iOS) or app-private `Directory.Data` (Android) under `BabylonSlate/projects/`; no picker. Android projects excluded from cloud backup. |
| Scoped / external | iPad / Android opt-in | Security-scoped bookmarks (`NSFileCoordinator`) / SAF tree URIs; root-confined paths; revoked access → **Reconnect Project Folder**. iOS resolves each bookmark once per session and holds its access: every resolution issues a sandbox extension and iOS caps them per process, so resolving per operation exhausted them and failed later folders until relaunch. SAF overwrites stage a sibling then rename. |
| Node | Electron main, tools | Root-confined through real paths; writes stage `.haptic-<uuid>.tmp`, flush and rename (no truncated files). |
| Electron | Desktop renderer | `ElectronStorageAdapter` over `project:*` IPC; one main-process Node adapter per editor document; project ids are `node:` paths under `userData/projects`. |
| HTTP catalog | Bundled engine plugins | `HttpCatalogStorageAdapter` over content-addressed immutable parts; never downloads archives; works without HTTP Range. |
| Read-only wrapper / Memory | Engine plugins / tests | Writes throw / in-memory tree. |

- **OPFS session lock:** a project (non-library) bind holds the Web Lock `haptic:opfs-session:<project id>` until `releaseFolder`, a bind of another project, or deleting that project. It is separate from the `haptic:opfs:<id>` lifecycle lock, which only covers a bind or delete. A project is therefore open in one tab; the journal and saves have a single writer. Refusal is taken with `ifAvailable` and throws `ProjectOpenElsewhereError` (`isProjectOpenElsewhere`) before any folder, meta or bound-project change, so the previous project stays bound. `deleteProject` needs the lock too (its own session counts); it borrows it for the deletion otherwise. Libraries take none. Locks die with their document, so reload and crash free the project, and the lock is released (and awaited) before the folder is reported released so a same-tab reopen is never refused. A host without `navigator.locks` cannot tell, so it does not refuse. Other adapters are single-window and unaffected.
- `withReadScope` gives a scan a bounded native directory-lookup cache (Android): ≤ 8,192 listing entries per scope, ≤ 8 scopes per plugin, cleared around every mutation. Not a snapshot.
- Mobile startup restores external folder ids without contacting the provider; recents reopen by stable id and never recreate missing folders.

## App-owned libraries and derived data

- `LIBRARY_FOLDERS` ([`library-folders.ts`](../../../packages/vfs/src/library-folders.ts)) is exactly `__slate_templates__`, `__slate_engine_plugins__`, `__slate_engine_extensions__`; renderer and Electron main share it. Electron binds each to `userData/libraries/<folder>` over `library:*` IPC (file operations only: no picker, open, list or release channels) and refuses any other scope.
- Derived data: `createDerivedStorage` root `__haptic_derived__` (OPFS library bind on web/Electron, beside projects on mobile). It is a regenerable cache.
- Templates: each directory with `project.json` or `.zip` in the template library is a card; only the chosen template is decoded. No user-chosen templates folder.

## Project creation

- Scaffold only into an empty folder (ignoring `.haptic-creating`, `.DS_Store`, `Thumbs.db`, `desktop.ini`); never overwrite. `.haptic-creating` marks an app-owned partial scaffold that a retry may clear.
- Persist the recent-project entry before the editor becomes interactive. Project identity for the browser lives in `project.json` metadata (`name`, optional `appearance`; uploaded images ≤ 96 KiB data URL).

## Write performance decision

The Documents tier crosses the Capacitor bridge once per asset write as base64 data with **no** `encoding` option: Capacitor Filesystem treats any encoding name as text (iOS writes an unknown one, such as `"base64"`, as UTF-8), which leaves base64 text on disk that native range reads then see. So: (1) write only dirty documents, (2) externalise large immutable chunks to the blob store (existing hashes are never rewritten), (3) debounce behind the command layer. **No pack format**: one `.hasset` per asset stays the on-disk unit, keeping the registry and Content Browser free of pack indirection. Revisit only with device numbers.

## App settings (Engine Settings)

- Global settings live outside any project; schema and defaults in [`app-settings.ts`](../../../packages/vfs/src/app-settings.ts). Backends: Capacitor Preferences (iOS/Android), `globalThis.haptic.userData` (Electron, `engine-settings.json` replaced atomically), localStorage (web).
- `AppSettingsStore.update` is a queued read-mutate-validate-write transaction across store instances; emit change events only after persistence.
- A refused save keeps settings in memory for the session; an unreadable file keeps `automaticUpdatesEnabled` off (it may hold an opt-out). A failed native Preferences read never overwrites stored settings.
- `compactMode` stays unset until chosen, so it follows the platform default (`resolveCompactMode`: on except on iOS and Android); Account → Application and Engine Settings → Interface edit it.
- `appearance.theme` stays in the schema for stored files, but nothing reads it and Engine Settings does not show it (the editor is dark only).
- Accessibility settings (`touchTargetScale`, `textSizePercent`, `reduceMotion`, `holdTimeMs`, `doubleTapTimeMs`, `numberSnapStrength`, `graphTapToConnect`, `graphPinScale`, `graphPinTypeLetters`) are stepped values: the schema rounds each number to its step and clamps it to its range on load.
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
- Preload exposes `haptic.userData`, `.project`, `.library`, `.secrets`, `.accountSecrets`, `.saveGames`, `.http`, `.files` (`file:save`, see [Saving exported files](#saving-exported-files)), `.memory` (`memory:stats`: the calling renderer's, the GPU process's, the main process's and every app process's working set, read-only, no arguments).

## Saving exported files

Every export (theme, project backup, Export Game, plugin, extension, save, diagnostic JSON) goes through `saveFile(name, blob)` in [`save-file.ts`](../../../packages/vfs/src/save-file.ts), which resolves `downloaded` / `saved` / `shared` / `cancelled`. Editor notices come from `savedFileNotice` ([`file-export.ts`](../../../apps/editor/src/lib/file-export.ts)); `cancelled` shows nothing and is never an error. The UI never builds anchors or calls the plugin itself.

| Host | Route | Result |
| --- | --- | --- |
| iOS app | `BabylonSlateFileExport` ([`capacitor-file-export.ts`](../../../packages/vfs/src/capacitor-file-export.ts)): `begin`, base64 `append` in 2 MiB chunks (never one bridge string), `finish` presents `UIActivityViewController` (iPad popover centred on the web view, no arrow) | `shared` / `cancelled` when the sheet closes |
| Android app | Same plugin; `finish` opens `ACTION_CREATE_DOCUMENT` and copies the file. A MIME type whose extension does not match the name is sent as `application/octet-stream`, or the provider appends its extension | `saved` / `cancelled` |
| Electron | `files.save` → `file:save` IPC: save dialog starting in Downloads, then a write; a name only (no separators), bytes ≤ 512 MiB. A larger file downloads, and Electron's default download (no `will-download` handler) also asks with a save dialog | `saved` / `cancelled` (`downloaded` above the limit) |
| iPhone/iPad browsers (`isAppleMobileOperatingSystem`) | `navigator.share({ files })` when `canShare` accepts the `File`; called before any `await`, so a caller inside a tap keeps its activation. `NotAllowedError` (a slow export outlived the tap) falls back to the anchor | `shared` / `cancelled` / `downloaded` |
| Other browsers | Anchor `download` on a blob URL revoked after 40 s (Safari and WKWebView read it late) | `downloaded` |

- Why native code: WKWebView and Capacitor Android ignore anchor downloads (Capacitor 8 has no `WKDownload` delegate or `DownloadListener`; iOS hands the `blob:` URL to `UIApplication.open` and cancels).
- The native temporary file lives alone in `haptic-exports/<id>/` under the app's temporary (iOS) or cache (Android) folder, so the sheet shows its real name; it is removed when `finish` settles, on `discard` (a failed `append`) and at plugin load.

## Platform decisions

- iOS WebContent process termination is handled by Capacitor's native reload; there is no app-level hook and we do not replace its private delegate. Journaled edits recover on reopen; Play and bakes never restart automatically.
- `StatusBarStylePort` only sets glyph style; never hide or overlay the native status bar.
- Android audio lifecycle never requests audio focus. iOS uses a `.playback` session mixed with other apps.
- Gameplay saves never live in project folders ([save-games](save-games.md)).
- File pickers apply no type filter on iPhone and iPad, in the app or a browser (`hostImportAccept`, [`import-picker.ts`](../../../packages/vfs/src/import-picker.ts)): WebKit maps each `accept` extension to a system type and greys out files of an extension iOS has none for (`.fbx`, `.hasset`, `.hextension`, `.hplugin`, `.babsave`). `pickImportFiles` and the hidden inputs iPadOS Safari opens (Content Browser, Plugins) all use it, so every caller checks the type of what it gets and refuses a wrong one by name. Desktop and Android keep the filter. Detection is `isAppleMobileOperatingSystem()` in [`platform.ts`](../../../packages/vfs/src/platform.ts): the iOS host, an iPhone/iPad user agent, or a Mac user agent with touch (iPadOS reports a Mac).
