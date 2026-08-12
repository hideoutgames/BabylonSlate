# VFS and app settings

Binary storage port and platform adapters for P1 (engineplan §§7.1–7.2, 12.4).

## ProjectStorage port (`@babylonslate/core`)

Text + binary filesystem over a bound project folder:

- `pickProjectFolder` / `openDocumentsProject` / `getCurrentFolder` / `releaseFolder`
- `readText` / `writeText` / `readBinary` / `writeBinary`
- `exists` / `readdir` / `mkdir` / `remove` / `stat`
- Folder handles carry `tier`: `documents` | `external` | `opfs`

UI never imports Capacitor; all I/O goes through `createStorage()` in `@babylonslate/vfs`.

## Adapter matrix

| Adapter | Host | Notes |
| --- | --- | --- |
| OPFS | Web | Replaces localStorage; binary-capable; projects under stable ids |
| Documents | iPad default | `@capacitor/filesystem` under `BabylonSlate/projects/`; no picker/bookmark; Files-visible via `UIFileSharingEnabled` + `LSSupportsOpeningDocumentsInPlace` |
| Scoped / external | iPad opt-in | Document picker; security-scoped bookmarks; `openKnownFolder` reopens without picker; Reconnect on staleness |
| Memory | Tests | In-memory tree |
| Node | CI / tools | Real filesystem under a root path |

`openKnownFolder(handle)` rebinds a previously known project (Documents / OPFS / external bookmark) without showing a picker. The picker is only for first bind and Reconnect.

### External tier / Working Copy spike

Sustained I/O into a file provider needs `NSFileCoordinator`, process-lifetime security scope, and bookmark staleness surfaced as **Reconnect project folder** on the Homepage. Expect a custom Swift plugin; the community scoped-storage plugin is the interim bridge. Device harness notes live with the adapter tests / docs when Mac/iPad is available.

## Two storage tiers (Homepage)

1. **Default (iPad):** app Documents — Create Project writes here with no prompt; cold reopen needs no picker.
2. **Opt-in external:** iCloud / Working Copy / any folder via picker; bookmarks persist in app settings.
3. **Web:** OPFS only; Export Project to get bytes out.

## App settings port

Global Engine Settings stored **outside** any project:

| Backend | Platform |
| --- | --- |
| Capacitor Preferences | iPad / Android |
| localStorage | Web |
| Electron userData bridge | Desktop — settings only until the P14 host lands |

Fields: templates folder, default project location, recents + bookmarks, appearance, undo history length (default 50), viewport frame cap (visible scene + Prefab Preview; freeze when hidden or a modal is open), hardware scaling, thumbnail toggle, debugger defaults.

`createAppSettingsStore()` picks Preferences on iOS/Android, `ElectronAppSettingsStore` when the host installed `globalThis.babylonslate.userData`, otherwise localStorage. With no bridge the Electron store keeps settings in memory, so desktop never silently loses them to a missing backend.

## Templates folder

`createTemplateStorage(folder)` binds the Engine Settings templates folder in the same tier as projects, so `listTemplates()` reads directory and zip templates through the ordinary project backends. Web has no folder picker for a templates location, so it offers **Empty only**; other hosts show a card per `*.babproject` entry that has a manifest. Entries without a manifest are skipped rather than failing the Homepage.

## Write performance decision (§19)

Cost model: the Documents tier crosses the Capacitor bridge **once per asset write**, with base64 encoding on each crossing (asserted in `write-bench.test.ts` with a fake filesystem). A file provider is slower still.

Decided for P1, in this order:

1. **Write only dirty documents.** Save walks the dirty set, never the whole tree.
2. **Blob store for large immutable chunks.** Chunks at or above the threshold externalise to `assets/.blobs/<sha256>`; an existing hash is never rewritten, so a re-save of an asset whose big chunks did not change writes no blob bytes.
3. **Debounce batches** behind the command layer ([command-layer.md](command-layer.md)): mark dirty on apply, flush dirty documents after a short idle.

**Pack format is not adopted.** One `.babasset` per asset stays the unit on disk; revisit only if device numbers show the first three are insufficient. That keeps the P2 registry and Content Browser free of a pack indirection they would otherwise have to assume.

CI covers memory, OPFS (jsdom memory fallback) and Documents-via-fake-filesystem; Playwright exercises real OPFS. Device Capacitor timings still need an iPad and remain open.
