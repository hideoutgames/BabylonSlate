# VFS and app settings

Binary storage port and platform adapters for P1 (engineplan §§7.1–7.2, 12.4).

## ProjectStorage port (`@babylonslate/core`)

Text + binary filesystem over a bound project folder:

- `pickProjectFolder` / `openDocumentsProject` / `getCurrentFolder` / `releaseFolder`
- `readText` / `writeText` / `readBinary` / `writeBinary`
- `readBinaryRange(path, offset, length, expectedRevision?)` — exact, bounded bytes plus file size, opaque revision, and actual bytes read; invalid bounds, short reads, and changed revisions reject
- `exists` / `readdir` / `mkdir` / `remove` / `stat`
- Optional `deleteProject` — implemented by OPFS and memory adapters; omitted on Documents / Electron / Capacitor so Homepage list-remove cannot trash native folders
- Folder handles carry `tier`: `documents` | `external` | `opfs`

UI never imports Capacitor; all I/O goes through `createStorage()` in `@babylonslate/vfs`.

### Bounded asset reads

Catalog mounting reads a `.babasset` prefix and header through `readBinaryRange`; it does not open each asset's payload. A subsequent read carries the catalog revision, and payload hashes validate the selected chunk. Range APIs never implement a partial read by slicing an already-loaded complete file.

- OPFS uses `File.slice().arrayBuffer()` and checks the file metadata before and after reading. Adapter writes also advance a shared revision counter, including equal-size writes within one timestamp tick.
- Node uses positioned file-descriptor reads and checks inode, size, nanosecond modification/change times, and the current path after reading. Electron forwards the bounded request through validated IPC.
- Capacitor Documents and external folders use the existing native storage plugin: `FileHandle` seeks on iOS and `pread` on Android. External iOS operations retain coordination/security scope; SAF requires a seekable regular descriptor and reports unsupported providers without falling back to a whole-file read. Native requests validate bounds before allocation and cap a single bridge transfer at 512 MiB.
- Memory storage gives every write a new revision. Read-only plugin wrappers and mobile read scopes preserve bounded reads and shared accounting.
- Revision invalidation crosses Electron/Capacitor as a dedicated error code and becomes `SourceRevisionChangedError`; malformed files and ordinary I/O failures remain distinct. A failed OPFS Blob slice is classified as stale only when a bounded metadata recheck confirms a changed revision. Error messages alone never trigger a retry.
- `getReadMetrics()` reports cumulative full/range operations, requested bytes, and bytes returned by the adapter's filesystem boundary. It includes explicit full reads and range bytes discarded by short-read/revision failures; native failures preserve their byte counts across the bridge. It is separate from source residency. These counters do not measure OS read-ahead, a cloud file provider's internal downloads, base64 transport copies, or physical-device peak memory.

Revisions detect changed sources; they are not filesystem transactions. `hasStrongSourceRevisions` is true only for owned memory generations and immutable HTTP catalogs. Disk adapters, including Node/Electron, conservatively leave it unset because filesystem timestamp precision varies. Asset readers refresh bounded headers for these mutable sources and include the header digest in the logical asset revision; deferred range reads retain the separate storage revision and validate chunk hashes. This detects equal-size header changes even when storage timestamps collide, without scanning payloads. Read-only and mounted views preserve this capability only when their underlying sources provide it. Unsupported bounded access is an actionable load failure, not permission to read the entire project eagerly. Native implementation still requires device qualification; local adapter tests do not establish A16 performance.

Bundled Engine Plugins use an HTTP file catalog. The build emits each `.babasset` prefix, JSON header, and inline chunk as a separate immutable content object; blob files are independently addressable too. Opening the catalog and taking a mounted library view do not download or unpack plugin archives. Normal catalog/chunk requests use whole small objects and work without HTTP Range support. Arbitrary partial reads require validated `206`/`Content-Range` responses; a server returning a full object is rejected before consuming its body. Responses are length-bounded while reading, complete objects are hash-checked, and discarded bytes are accounted.

`createMountedProjectStorage` combines read-only directory/file views with the most specific path winning, including small settings overrides. Views retain storage locations and metadata, not copies of plugin payloads. Imported plugin generations and their explicit legacy upgrade are described in [plugins](plugins.md).

## Adapter matrix

| Adapter | Host | Notes |
| --- | --- | --- |
| OPFS | Web | Replaces localStorage; binary-capable; projects under stable ids; Homepage remove deletes the OPFS directory; `readdir` skips Chromium's `*.crswap` write swap files and entries removed mid-listing, so a concurrent save never fails a whole listing (an asset rescan would otherwise publish an empty Content Browser); `readBinary` reads again when a save replaces the file between `getFile()` and the read (Chromium fails that stale snapshot with `NotReadableError` / `NotFoundError`), so a Preview reading a Texture while its encode commits gets the saved bytes; a snapshot that stays unreadable reports its real read error instead of `File not found` |
| Documents | iPad default | `@capacitor/filesystem` `Directory.Documents` under `BabylonSlate/projects/`; no picker/bookmark; Files-visible via `UIFileSharingEnabled` + `LSSupportsOpeningDocumentsInPlace` |
| Documents | Android default | App-private `Directory.Data` under `BabylonSlate/projects/`; Android 11+ public Documents is unreadable without a picker |
| Scoped / external | iPad opt-in | Document picker; security-scoped bookmarks; root-confined relative paths; `openKnownFolder` reopens without picker; Reconnect on staleness or revoked scope access |
| Scoped / external | Android opt-in | SAF `ACTION_OPEN_DOCUMENT_TREE`; persisted read/write URI permissions; `DocumentsContract` child traversal; UUID handles map to tree URIs in native SharedPreferences; no `importBookmark` |
| Memory | Tests | In-memory tree |
| Read-only wrapper | Engine plugins | `createReadOnlyProjectStorage(inner)` — reads pass through; `write*` / `mkdir` / `remove` / `deleteProject` throw |
| Node | CI / tools | Real filesystem under a root path; `openAbsoluteFolder` for Electron pickers |
| Electron | Desktop editor | Renderer `ElectronStorageAdapter` over preload IPC; main process `NodeStorageAdapter` |

`openKnownFolder(handle)` rebinds a previously known project (Documents / OPFS / external bookmark) without showing a picker. The picker is only for first bind and Reconnect.

Browser project writes require OPFS; an unavailable or denied filesystem reports an error instead of accepting temporary in-memory saves. Project handles keep their existing ids, while metadata maps new projects to distinct hashed directories. Legacy directories remain readable; opening a remembered name alias copies its shared legacy contents into an independent directory, and deleting an unresolved alias preserves other projects' files. Tests inject an explicit OPFS filesystem boundary.

OPFS directory creation is recursive by default; `mkdir(path, false)` requires existing parent directories.

Project lifecycle operations serialize by id across adapter instances and use Web Locks across browser tabs when available, so a second legacy migration cannot replay over a newer save. Metadata merges use a separate origin-wide Web Lock. Deletion reconciles the latest metadata after filesystem I/O, preserving unrelated project registrations.

Node operations validate relative path segments and root containment, including siblings whose names share the project prefix. `readdir(".")` lists the project root on every adapter, including external mobile folders. Full project exports propagate directory-listing failures so an unreadable subtree cannot silently produce a partial backup.

### External tier / Working Copy spike

iPad file-provider I/O uses `NSFileCoordinator` and acquires/releases security scope for each operation, including metadata checks. Android SAF retains read/write URI permission and resolves each path segment through `DocumentsContract` cursor results. Both plugins reject absolute/traversing paths and surface revoked access.

Registry mounting optionally uses `ProjectStorage.withReadScope` to reuse Android directory lookups throughout one recursive scan. Each scope has an independent native cache, closed in `finally`; ordinary reads and later scans start fresh. Cached listings also index child names, avoiding one provider enumeration per asset. Native mutations clear open caches before and after their I/O, with native file operations serialized to prevent stale queries repopulating a cache after a write. Each scope retains at most 8,192 listing entries (an empty directory counts as one), evicts older directories, and skips caching larger single listings; at most eight scopes are open per plugin. These are lookup caches, not transactional snapshots of externally changing provider files. iOS and other adapters keep their existing read behavior.

WebView navigation also closes abandoned scopes, because a reload can skip JavaScript `finally` blocks. Navigation and plugin destruction queue cleanup on Capacitor's task thread so UI lifecycle callbacks never wait for provider I/O.

- Mobile operations await one initialization pass before selecting a storage tier. Restoring an old bookmark cannot redirect a new project's writes. Expired access remains visible as **Reconnect Project Folder** after startup or a failed recent-project open.
- An unreachable legacy bookmark retains its reconnect identity without blocking Documents initialization. Reopening a Documents recent requires the directory to exist; it never recreates a deleted project folder.
- Legacy bookmarks migrate when opened from recents. Missing bookmarks and denied permissions require reconnect; missing files remain ordinary missing-file results. Provider failures never imply an empty destination.
- Documents and external paths reject traversal, absolute paths, and project-root mutations. Documents recents reopen by stable id, independently of their display name; already-existing native directories remain usable.
- Creating from a template refuses an existing project. Reconnect validates `project.json` and the open project's GUID before rebinding; selecting an empty or different project keeps the previous recovery target and retry action. A missing bookmarked root requires reconnect and is never recreated by a child write.
- Imported audio is copied into project asset chunks and read through the same selected storage adapter for preview and Play. A failed Files-provider import rejects and cleans up the picker so it can be retried.

## Two storage tiers (Homepage)

1. **Default (Capacitor, Electron):** iPad `Directory.Documents`, Android app-private `Directory.Data`, or Electron `userData/projects` — Create Project writes here with no picker until the user taps **Choose Location…**. Cold reopen of Documents projects needs no picker. The Create Project Name field starts **empty** with a random suggested name as its placeholder, used when nothing is typed (automation types `TestProject`). Native **Choose Location…** is a required full-width `Button` (not a ToggleGroup) that arms `pickProjectFolder` at Create; **App Documents** / **Projects Folder** returns to the default. Web omits the Location line (internal OPFS). A colliding name warns **Name already exists.** while typing instead of loading that folder. Capacitor and Electron never fall through to the OPFS adapter.
2. **Opt-in external:** iCloud / Working Copy / any folder via picker; bookmarks persist in app settings.
3. **Web:** OPFS only; Export Project to get bytes out. Removing a listed OPFS project deletes its directory (and OPFS meta), not just the recents row. Recents show no storage location, so the `opfs` API name never appears.

## App settings port

Global Engine Settings stored **outside** any project:

- **Debugger → Trace Memory Budget (MiB)** stores `traceByteBudget` in bytes. New and legacy settings default to 128 MiB; finite values clamp to 1–256 MiB. The next Play or Preview Build session uses the saved budget for snapshot recording, discarding the oldest frames when it fills.
- `automaticUpdatesEnabled` defaults to `true` for legacy and new settings. The Electron main process reads it before its first release check and applies saved changes immediately. Web/iOS update delivery is unchanged.
- `seenReleaseVersions` stores dismissed news versions (default `[]`) through the same localStorage, Electron userData, or Capacitor Preferences backend. The launcher waits for hydration before showing version news; opening the account menu's **Changelog** remains available after dismissal and offline.

- `viewportDropDistance` is the positive finite Scene/Prefab Drop cutoff exposed under Viewport ? Drop Distance. Older settings default to 10,000 world units; changes persist and take effect on the next Drop click.

- `AppSettingsStore.update` queues a latest-read, focused mutation, schema validation, and write transaction across independently created stores. It emits the settings-change event after persistence, preventing concurrent debugger, viewport, appearance, and recent-project updates from overwriting one another.
- Opening or creating a project persists its recent-project entry before the editor becomes interactive. Reloading during later texture-transcoder setup therefore keeps the project available on Homepage for reopening and journal recovery.
- Project-browser identity lives in `project.json` metadata: `name` and optional `appearance: { icon, color, image? }`. Icon and color are catalog identifiers; uploaded PNG, JPEG, or WebP images are small data URLs, bounded to 96 KiB of encoded text. Legacy projects without appearance use the default badge. Invalid imported images are discarded without losing project access.
- Recents cache that metadata so project cards need no folder reads. Opening a project refreshes the cache from its metadata, preserving edited names and badges across reopening. Editing changes metadata and its cache after the project write succeeds; the folder name, handle, templates, and game assets stay unchanged. New projects can choose a badge independently of their template.

| Backend | Platform |
| --- | --- |
| Capacitor Preferences | iPad / Android |
| localStorage | Web |
| Electron userData + project IPC | Desktop — `globalThis.babylonslate.userData` for Engine Settings; `babylonslate.project` for the Node VFS |

Fields: recents + bookmarks (each recent also caches the project's appearance and optional `sourceControl` flag for Homepage badges), appearance, undo history length (default 50), viewport frame cap (visible scene + Prefab Preview; freeze when hidden or a modal is open), hardware scaling, editor camera fly speed (`viewportFlySpeed` default 8), Prefab viewport grid size (`viewportGridSize` default 1) and independent movement snap (`viewportSnapTranslate` default 1; missing values migrate once from the saved grid size), model import default scale (`modelImportDefaultScale` default 1 — stamped onto new Model assets only), editor texture LOD (`editorTextureLodEnabled` default on, `editorTextureLodQuality` default 0.5), texture memory budget (`textureBudgetEnabled` default on, `textureByteCeiling` default 2 GB), audio memory budget (`audioBudgetEnabled` default on, `audioByteCeiling` default 256 MB), max concurrent voices (`audioMaxVoices` default 32, range 8–128), thumbnail toggle, debugger defaults, Focus keep-lists (`focusKeepPanels` keys: `scene` default `["viewport"]`, `graph` default `["graph"]`, `enum` / `structure` members, `script-interface` Preview, `sprite` / `tileset` preview, `tilemap` paint, `material` / `material-function` graph, `plugin-settings` Details, `anim-graph` Graph, `animGraphObject` Graph, `behaviour-tree` Graph — already-open dock tabs that stay when Focus is on), graph default zoom (`graphDefaultZoom` default 0.5, range 0.1–1.5 — opening, Controls, and focused-node fit-view cap for node graphs).

Number fields (frame cap, hardware scaling, pointer scale, undo length, graph default zoom, camera speed, Prefab grid size, model import default scale, texture budget MB, audio budget MB, max voices, and Project Settings `pixelsPerUnit`) use `NumberField`: an empty draft while typing does not persist, and blur restores the last valid value. Out-of-range drafts clamp on blur. Focusing the field selects all on first click, tap, or Tab.

`createAppSettingsStore()` picks Preferences on iOS/Android, `ElectronAppSettingsStore` when the host installed `globalThis.babylonslate.userData`, otherwise localStorage. If a bridge read or write fails, the Electron store keeps settings in memory for the session.

## Capacitor public copies (P14)

Capacitor `webDir` is editor `dist`. `cap sync ios` fills gitignored `ios/App/App/public/`; `cap sync android` fills gitignored `android/app/src/main/assets/public/`. Both include `coi-serviceworker.js`, `havok/`, `ktx2/`, `draco/`, `meshopt/`, and `/player/`. WKWebView needs a first-gesture audio unlock (Play overlay pointerdown + player `pointerdown`/`touchstart`). Generated public copies are not source. The iOS copy contract is asserted in `packages/vfs/src/capacitor-ios.test.ts`; Android plugin and generated wiring contracts are asserted in `packages/vfs/src/capacitor-android.test.ts`.

## WebContent termination (iOS)

Capacitor 8.5.0 handles `webViewWebContentProcessDidTerminate` natively — `WebViewDelegationHandler` resets the bridge and reloads the WebView, unbounded, and there is no app-level hook without replacing the private delegate, which we do not do. The reload restarts the editor at Home without a notice. Reopening the project recovers journaled edits; in-memory edits never journaled are lost. Play and bakes are never restarted automatically.

## Template library

`createTemplateStorage(root)` binds an app-owned folder (`__slate_templates__` for templates) in the same tier as projects, so `listTemplates()` reads directory and zip templates through the ordinary project backends on every host. There is no user-chosen templates folder; a `templatesFolder` key in older saved settings is dropped on load. Each directory or `.zip` / legacy `.babproject` entry with a `project.json` manifest becomes a card. Entries without a manifest are skipped rather than failing the Homepage.

## Write performance decision (§19)

Cost model: the Documents tier crosses the Capacitor bridge **once per asset write**, with base64 encoding on each crossing (asserted in `write-bench.test.ts` with a fake filesystem). A file provider is slower still.

Decided for P1, in this order:

1. **Write only dirty documents.** Save walks the dirty set, never the whole tree.
2. **Blob store for large immutable chunks.** Chunks at or above the threshold externalise to `assets/.blobs/<sha256>`; an existing hash is never rewritten, so a re-save of an asset whose big chunks did not change writes no blob bytes.
3. **Debounce batches** behind the command layer ([command-layer.md](command-layer.md)): mark dirty on apply, flush dirty documents after a short idle.

**Pack format is not adopted.** One `.babasset` per asset stays the unit on disk; revisit only if device numbers show the first three are insufficient. That keeps the P2 registry and Content Browser free of a pack indirection they would otherwise have to assume.

CI covers memory, OPFS through an explicit filesystem boundary (including durable reopen, name migration, denied access, swap-file listings and stale reads), and Documents through a fake filesystem; Playwright exercises real OPFS. Device Capacitor timings still need an iPad and remain open.

## SecretStore and nativeHttp (P15)

Source-control tokens and LFS HTTP stay in `vfs` so Capacitor / Electron never leak into `@babylonslate/source-control` or the editor. Detail: [source-control.md](source-control.md).

`SecretStore`: `get` / `set` / `delete(key)` keyed `source-control:{projectGuid}`.

| Host | Backend |
| --- | --- |
| iOS | First-party `BabylonSlateSecrets` Keychain plugin compiled in the App target and retained in `packageClassList` after sync. **Not** Capacitor Preferences. |
| Android | App-module `BabylonSlateSecrets` plugin, registered in `MainActivity`; an AndroidKeyStore AES-GCM key encrypts ciphertext held in private SharedPreferences, which backup/transfer rules exclude because the device-bound key cannot migrate. **Not** Capacitor Preferences. |
| Electron | Preload `babylonslate.secrets` → IPC `secrets:get` / `secrets:set` / `secrets:delete` → a versioned file whose records explicitly tag `safeStorage` ciphertext or plaintext. Mutations are serialized to prevent lost updates. Linux hosts without a keyring write tagged plaintext; encrypted reads fail while decryption is unavailable and never expose ciphertext. |
| Web | `UnavailableSecretStore` (`available: false`) — Source Control UI hidden |

`nativeHttp`: `{ method, url, headers, body? }` → `{ status, bodyText }`. iOS/Android use `CapacitorHttp` (bypasses CORS). Electron uses IPC `lfs:fetch` → `net.fetch`. Web returns `null` (unused). Playwright covers lock UX with `FakeLockProvider` instead.

Native HTTP responses expose optional `headers`, used by the native project-browser account adapter to persist Clerk's rotating client token. The adapter uses the [versioned public Frontend API](https://github.com/clerk/openapi-specs/tree/main/fapi), sends form-encoded email-code requests with `_is_native=1`, and restores access only after Clerk returns an active session. Client credentials stay in iOS Keychain or Android Keystore-backed `SecretStore`. Electron uses the separate `createAccountSecretStore()` / `accountSecrets` preload bridge: account tokens are OS-encrypted in `account-secrets.json`, or stay in main-process memory when secure encryption is unavailable (including Linux `basic_text`). Existing source-control credential behavior is unchanged. Electron HTTP preserves response headers, omits browser cookies, and rejects redirects. Tokens, verification codes, and raw server diagnostics never enter app settings or user-facing errors. Sign-out revokes the session before removing local credentials, including any older encrypted cache from a memory-only run.

While the native project browser is mounted, window focus and visibility resume trigger a fresh server check. Project actions are hidden during validation or sign-out; failed requests retain credentials and show a retry gate. Pending results and focus listeners cannot outlive the Home route. The editor has no account polling or listeners.

Desktop account-cache writes replace the file atomically. Invalid cache JSON or schema is treated as a missing sign-in; OS decryption failures retain the encrypted cache and report temporary unavailability.

Native account builds require Clerk's Native API and email-code sign-in/sign-up to be enabled. Additional mandatory profile fields, MFA, OAuth, and passkeys need corresponding flows before enabling them for app users; unsupported requirements keep the account form closed. Web authentication uses the optional Clerk React flow; Electron embeds the native email-code flow optionally in Profile. Native integration tests cover transport and session continuity with controlled API responses; real Clerk credentials and physical-device verification remain separate from browser emulation.

`StatusBarStylePort` accepts `"light"` or `"dark"` glyph styles. iOS/Android use the Capacitor Status Bar plugin's `setStyle` only; Web and Electron use a no-op adapter. The editor maps resolved dark chrome to light glyphs and resolved light chrome to dark glyphs. It never hides or overlays the native status bar.

Android audio lifecycle reports route additions/removals from device callbacks and becoming-noisy broadcasts. API 31+ audio mode changes model call/ringtone interruptions. It never requests audio focus, so other apps keep playing. Android memory stats report host-process PSS and system `availMem`; there is no jetsam-style per-process allowance, and the separate WebView renderer is not included.

## Player saved games

`createSaveGameStorage()` implements the core `SaveGameStorage` port beside project storage. It never writes gameplay saves into project folders. `SaveGameService` owns versioned payloads, checksums, alternating generations, recovery and the stable project / game-or-preview / profile / slot namespace.

| Host | Private location and commit behavior |
| --- | --- |
| Web | OPFS `babylonslate-game-saves`; writable streams stage changes until `close()`. An exclusive Web Lock spans the service transaction across tabs. Browser persistence requests return the browser decision; storage remains clearable. |
| iOS | Capacitor `Directory.Library/Application Support/BabylonSlate/game-saves`, independent of Files-visible Documents. Temporary write then rename; Web Locks serialize WebView contexts. |
| Android | Capacitor `Directory.Data/BabylonSlate/game-saves`; temporary write then rename; Web Locks serialize WebView contexts. |
| Electron | `userData/game-saves`; main-process temporary file, file sync, rename, then directory sync on POSIX. The application single-instance lock prevents competing host processes; owned IPC leases serialize windows and release on reload, crash or close. |

- Filesystem names encode the logical key bytes so case-insensitive hosts cannot merge differently named profiles or slots. Paths reject traversal, empty segments and oversized encoded names.
- Missing results are reserved for explicit not-found errors. Permission and storage errors propagate; quota errors and explicit native `ENOSPC`/`EDQUOT` map to storage-full. Capacitor generic I/O errors are not guessed to mean full.
- Browser/mobile contexts without Web Locks reject save operations instead of falling back to unsafe local-only locking. Electron preserves error categories through structured IPC responses and rejects storage access without the window's matching lock.
- The service only replaces the inactive generation. Capacitor offers no filesystem sync API or documented power-loss guarantees; real iOS/Android interruption, mobile Web Locks and Windows power-loss behavior remain unverified. Local filesystem tests do not establish A16 iPad performance.
- Native adapters support the existing editor hosts. Current exported-game packaging is web-only; native shipped-game packaging/parity is not implied by these adapters.

Official references: [OPFS writable commit](https://developer.mozilla.org/en-US/docs/Web/API/FileSystemFileHandle/createWritable), [Web Locks](https://developer.mozilla.org/en-US/docs/Web/API/Web_Locks_API), [Capacitor private directories](https://capacitorjs.com/docs/apis/filesystem#directory), [Electron userData](https://www.electronjs.org/docs/latest/api/app#appgetpathname).
