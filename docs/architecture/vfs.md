# VFS and app settings

Binary storage port and platform adapters for P1 (engineplan §§7.1–7.2, 12.4).

## ProjectStorage port (`@babylonslate/core`)

Text + binary filesystem over a bound project folder:

- `pickProjectFolder` / `openDocumentsProject` / `getCurrentFolder` / `releaseFolder`
- `readText` / `writeText` / `readBinary` / `writeBinary`
- `exists` / `readdir` / `mkdir` / `remove` / `stat`
- Optional `deleteProject` — implemented by OPFS and memory adapters; omitted on Documents / Electron / Capacitor so Homepage list-remove cannot trash native folders
- Folder handles carry `tier`: `documents` | `external` | `opfs`

UI never imports Capacitor; all I/O goes through `createStorage()` in `@babylonslate/vfs`.

## Adapter matrix

| Adapter | Host | Notes |
| --- | --- | --- |
| OPFS | Web | Replaces localStorage; binary-capable; projects under stable ids; Homepage remove deletes the OPFS directory |
| Documents | iPad default | `@capacitor/filesystem` under `BabylonSlate/projects/`; no picker/bookmark; Files-visible via `UIFileSharingEnabled` + `LSSupportsOpeningDocumentsInPlace` |
| Scoped / external | iPad opt-in | Document picker; security-scoped bookmarks; `openKnownFolder` reopens without picker; Reconnect on staleness |
| Memory | Tests | In-memory tree |
| Read-only wrapper | Engine plugins | `createReadOnlyProjectStorage(inner)` — reads pass through; `write*` / `mkdir` / `remove` / `deleteProject` throw |
| Node | CI / tools | Real filesystem under a root path; `openAbsoluteFolder` for Electron pickers |
| Electron | Desktop editor | Renderer `ElectronStorageAdapter` over preload IPC; main process `NodeStorageAdapter` |

`openKnownFolder(handle)` rebinds a previously known project (Documents / OPFS / external bookmark) without showing a picker. The picker is only for first bind and Reconnect.

### External tier / Working Copy spike

Sustained I/O into a file provider needs `NSFileCoordinator`, process-lifetime security scope, and bookmark staleness surfaced as **Reconnect project folder** on the Homepage. Expect a custom Swift plugin; the community scoped-storage plugin is the interim bridge. Device harness notes live with the adapter tests / docs when Mac/iPad is available.

## Two storage tiers (Homepage)

1. **Default (iPad / Capacitor, Electron):** app Documents (Electron: `userData/projects`) — Create Project writes here with no picker until the user taps **Choose Location…**. Cold reopen of Documents projects needs no picker. The Create Project Name field starts **empty** on live (`TestProject` in `/?test=1` / `VITE_TEST_MODE`). Native **Choose Location…** is a required full-width `Button` (not a ToggleGroup) that arms `pickProjectFolder` at Create; **App Documents** / **Projects Folder** returns to the default. Web omits the Location line (internal OPFS). A colliding name warns **Name already exists.** instead of loading that folder. Capacitor and Electron never fall through to the OPFS adapter.
2. **Opt-in external:** iCloud / Working Copy / any folder via picker; bookmarks persist in app settings.
3. **Web:** OPFS only; Export Project to get bytes out. Removing a listed OPFS project deletes its directory (and OPFS meta), not just the recents row. Recents never show the `opfs` API name: hide the location when every listed project is the same tier; mixed lists (Documents vs a picked folder) use **On this device** and **Chosen folder**.

## App settings port

Global Engine Settings stored **outside** any project:

| Backend | Platform |
| --- | --- |
| Capacitor Preferences | iPad / Android |
| localStorage | Web |
| Electron userData + project IPC | Desktop — `globalThis.babylonslate.userData` for Engine Settings; `babylonslate.project` for the Node VFS |

Fields: templates folder, default project location, recents + bookmarks, appearance, undo history length (default 50), viewport frame cap (visible scene + Prefab Preview; freeze when hidden or a modal is open), hardware scaling, editor camera fly speed (`viewportFlySpeed` default 8), Prefab viewport grid size (`viewportGridSize` default 1), model import default scale (`modelImportDefaultScale` default 1 — stamped onto new Model assets only), editor texture LOD (`editorTextureLodEnabled` default on, `editorTextureLodQuality` default 0.5), texture memory budget (`textureBudgetEnabled` default on, `textureByteCeiling` default 2 GB), audio memory budget (`audioBudgetEnabled` default on, `audioByteCeiling` default 256 MB), max concurrent voices (`audioMaxVoices` default 32, range 8–128), thumbnail toggle, debugger defaults, Focus keep-lists (`focusKeepPanels` keys: `scene` default `["viewport"]`, `graph` default `["graph"]`, `enum` / `structure` members, `script-interface` Preview, `sprite` / `tileset` preview, `tilemap` paint, `material` / `material-function` graph, `plugin-settings` Details, `anim-graph` Graph, `animGraphObject` Graph, `behaviour-tree` Graph — already-open dock tabs that stay when Focus is on), graph default zoom (`graphDefaultZoom` default 0.5, range 0.1–1.5 — opening, Controls, and focused-node fit-view cap for node graphs).

Number fields (frame cap, hardware scaling, pointer scale, undo length, graph default zoom, camera speed, Prefab grid size, model import default scale, texture budget MB, audio budget MB, max voices, and Project Settings `pixelsPerUnit`) use `NumberField`: an empty draft while typing does not persist, and blur restores the last valid value. Out-of-range drafts clamp on blur. Focusing the field selects all on first click, tap, or Tab.

`createAppSettingsStore()` picks Preferences on iOS/Android, `ElectronAppSettingsStore` when the host installed `globalThis.babylonslate.userData`, otherwise localStorage. With no bridge the Electron store keeps settings in memory, so desktop never silently loses them to a missing backend.

## iOS public copy (P14)

Capacitor `webDir` is editor `dist`. `npx cap copy` / Xcode sync fills `ios/App/App/public/` (gitignored) from that dist, including `coi-serviceworker.js`, `havok/`, `ktx2/`, and `/player/`. WKWebView needs a first-gesture audio unlock (Play overlay pointerdown + player `pointerdown`/`touchstart`). Do not treat the gitignored iOS `public/` snapshot as source — the copy contract is asserted in `packages/vfs/src/capacitor-ios.test.ts`.

## Templates folder

`createTemplateStorage(folder)` binds the Engine Settings templates folder in the same tier as projects, so `listTemplates()` reads directory and zip templates through the ordinary project backends. Web has no folder picker for a templates location. Create Project still offers built-in **Empty** and **2D** cards; the Homepage copy does not advertise Engine Settings templates on web. Other hosts show a card per directory or `.zip` / legacy `.babproject` entry that has a `project.json` manifest. Entries without a manifest are skipped rather than failing the Homepage.

## Write performance decision (§19)

Cost model: the Documents tier crosses the Capacitor bridge **once per asset write**, with base64 encoding on each crossing (asserted in `write-bench.test.ts` with a fake filesystem). A file provider is slower still.

Decided for P1, in this order:

1. **Write only dirty documents.** Save walks the dirty set, never the whole tree.
2. **Blob store for large immutable chunks.** Chunks at or above the threshold externalise to `assets/.blobs/<sha256>`; an existing hash is never rewritten, so a re-save of an asset whose big chunks did not change writes no blob bytes.
3. **Debounce batches** behind the command layer ([command-layer.md](command-layer.md)): mark dirty on apply, flush dirty documents after a short idle.

**Pack format is not adopted.** One `.babasset` per asset stays the unit on disk; revisit only if device numbers show the first three are insufficient. That keeps the P2 registry and Content Browser free of a pack indirection they would otherwise have to assume.

CI covers memory, OPFS (jsdom memory fallback) and Documents-via-fake-filesystem; Playwright exercises real OPFS. Device Capacitor timings still need an iPad and remain open.

## SecretStore and nativeHttp (P15)

Source-control tokens and LFS HTTP stay in `vfs` so Capacitor / Electron never leak into `@babylonslate/source-control` or the editor. Detail: [source-control.md](source-control.md).

`SecretStore`: `get` / `set` / `delete(key)` keyed `source-control:{projectGuid}`.

| Host | Backend |
| --- | --- |
| iOS / Android | First-party `BabylonSlateSecrets` Capacitor plugin (Keychain / Keystore). **Not** `@capacitor/preferences`. The Swift plugin is compiled in the iOS App target (`BabylonSlateSecretsPlugin.swift` in Sources) and listed in `ios/App/App/capacitor.config.json` `packageClassList`. Keep that class listed after `npx cap sync`. There is no Android editor shell yet. |
| Electron | Preload `babylonslate.secrets` → IPC `secrets:get` / `secrets:set` / `secrets:delete` → `safeStorage.encryptString` / `decryptString` when encryption is available. Linux hosts without a keyring fall back to storing the packed string unencrypted (accepted host limit). |
| Web | `UnavailableSecretStore` (`available: false`) — Source Control UI hidden |

`nativeHttp`: `{ method, url, headers, body? }` → `{ status, bodyText }`. iOS/Android use `CapacitorHttp` (bypasses CORS). Electron uses IPC `lfs:fetch` → `net.fetch`. Web returns `null` (unused). Playwright covers lock UX with `FakeLockProvider` instead.

