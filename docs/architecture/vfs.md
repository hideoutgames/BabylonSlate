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
| OPFS or localStorage | Web |
| Electron userData | Desktop (stub until P14) |

Fields: templates folder, default project location, recents + bookmarks, appearance, undo history length (default 50), viewport frame cap, hardware scaling, thumbnail toggle, debugger defaults.

## Write performance (§19)

Many small Capacitor writes are slow. Mitigations (decide in P1 before registry): write only dirty assets, blob store for large immutable chunks, debounce batches. CI microbench covers memory + OPFS adapters (jsdom uses the OPFS memory fallback; Playwright exercises real OPFS). Device Capacitor write numbers when available.
